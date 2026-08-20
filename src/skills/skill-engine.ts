import { z } from "zod";
import { emitSseEvent, getRuntimeContext } from "../common/run-context.js";
import type { AppLogger } from "../common/logger.js";
import type { ModelAdapter } from "../model/model-adapter.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolCall } from "../tools/types.js";
import type { ToolRegistry } from "../tools/types.js";
import type { ThreadStore } from "../persistence/thread-store.js";
import { HumanConfirmationRecordSchema } from "../schemas/human-confirmation.js";
import {
  SkillToolPlanSchema,
  type PreparedSkillExecution,
  type SkillPlanItem
} from "./types.js";
import type { SkillLoader } from "./skill-loader.js";

const ExecutionResultSchema = z.object({
  skillName: z.string(),
  output: z.string(),
  toolResults: z.array(z.unknown())
});

export type SkillExecutionResult = z.infer<typeof ExecutionResultSchema>;

export class SkillEngine {
  constructor(
    private readonly loader: SkillLoader,
    private readonly registry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly threadStore: ThreadStore,
    private readonly logger: AppLogger
  ) {}

  async prepare(
    plan: SkillPlanItem,
    model: ModelAdapter
  ): Promise<PreparedSkillExecution> {
    const context = getRuntimeContext();
    const skill = await this.loader.load(plan.skillName);
    emitSseEvent("state_update", {
      requestId: context.requestId,
      threadId: context.threadId,
      userId: context.userId,
      data: {
        status: "skill_loaded",
        node: "skill_engine",
        detail: { skillName: skill.name }
      }
    });

    const allowedTools = skill.allowedToolsList;
    const toolNames = allowedTools.length > 0 ? allowedTools.join(", ") : "none";
    const toolPlan = await model.invokeJson(
      model.helperMessages(
        [
          "You are a skill execution planner.",
          `Skill name: ${skill.name}`,
          `Skill instructions:\n${skill.instructions}`,
          `Available skill tools: ${toolNames}`,
          "Only choose tools listed in allowedTools.",
          "Return a tool execution plan. Use parallel only when calls are independent."
        ].join("\n"),
        plan.input
      ),
      SkillToolPlanSchema,
      { operation: `skill_plan:${skill.name}` }
    );

    for (const call of toolPlan.calls) {
      if (!allowedTools.includes(call.toolName)) {
        throw new Error(
          `Skill ${skill.name} attempted unregistered tool ${call.toolName}`
        );
      }
    }

    const highRiskCall = toolPlan.calls.find((call) => {
      const tool = this.registry.getRequired(call.toolName);
      return tool.risk !== "low";
    });

    if (highRiskCall) {
      const tool = this.registry.getRequired(highRiskCall.toolName);
      const args = tool.argsSchema.parse(highRiskCall.args);
      const confirmation = HumanConfirmationRecordSchema.parse({
        confirmationId: `${skill.name}:${highRiskCall.toolCallId}`,
        threadId: context.threadId,
        userId: context.userId,
        skillName: skill.name,
        toolName: tool.name,
        toolCallId: highRiskCall.toolCallId,
        risk: tool.risk === "low" ? "medium" : tool.risk,
        args,
        reason: `Skill ${skill.name} wants to execute ${tool.risk}-risk tool ${tool.name}`,
        createdAt: new Date().toISOString()
      });
      await this.threadStore.setPendingConfirmation(context.threadId, confirmation);

      emitSseEvent("need_human_confirm", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: confirmation
      });

      return {
        skill,
        input: plan.input,
        mode: plan.mode,
        reason: plan.reason,
        toolPlan,
        requiresConfirmation: true,
        confirmation
      };
    }

    return {
      skill,
      input: plan.input,
      mode: plan.mode,
      reason: plan.reason,
      toolPlan,
      requiresConfirmation: false
    };
  }

  async executePrepared(
    prepared: PreparedSkillExecution,
    model: ModelAdapter,
    options: { allowHighRisk: boolean }
  ): Promise<SkillExecutionResult> {
    const context = getRuntimeContext();
    const toolResults: unknown[] = [];
    if (prepared.toolPlan.calls.length > 0) {
      const calls: ToolCall[] = prepared.toolPlan.calls;
      const results = await this.toolExecutor.executeCalls(
        calls,
        prepared.toolPlan.mode,
        {
          allowHighRisk: options.allowHighRisk,
          skillName: prepared.skill.name
        }
      );
      toolResults.push(...results.map((item) => item.result));
    }

    const output = await model.invokeText(
      model.helperMessages(
        [
          "You are a skill result synthesizer.",
          `Skill instructions:\n${prepared.skill.instructions}`,
          "Use the tool results and user task to produce concise, factual output.",
          "Do not claim an action succeeded unless a tool result proves it."
        ].join("\n"),
        JSON.stringify({ task: prepared.input, toolResults })
      ),
      { operation: `skill_summarize:${prepared.skill.name}` }
    );

    this.logger.info(
      {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        skillName: prepared.skill.name,
        toolCount: toolResults.length
      },
      "skill_completed"
    );
    return ExecutionResultSchema.parse({
      skillName: prepared.skill.name,
      output: output.text,
      toolResults
    });
  }

  async prepareMany(
    plans: SkillPlanItem[],
    model: ModelAdapter
  ): Promise<PreparedSkillExecution[]> {
    const parallelPlans = plans.filter((item) => item.mode === "parallel");
    const serialPlans = plans.filter((item) => item.mode === "serial");
    const results: PreparedSkillExecution[] = [];

    // Parallel plans are prepared concurrently; serial plans preserve model order.
    results.push(...(await Promise.all(
      parallelPlans.map((plan) => this.prepare(plan, model))
    )));
    for (const plan of serialPlans) {
      results.push(await this.prepare(plan, model));
      if (results.at(-1)?.requiresConfirmation) {
        break;
      }
    }
    return results;
  }

  async executeManyPrepared(
    prepared: PreparedSkillExecution[],
    model: ModelAdapter,
    options: { allowHighRisk: boolean }
  ): Promise<SkillExecutionResult[]> {
    const parallel = prepared.filter((item) => item.mode === "parallel");
    const serial = prepared.filter((item) => item.mode === "serial");
    const results: SkillExecutionResult[] = [];

    results.push(
      ...(await Promise.all(
        parallel.map((item) => this.executePrepared(item, model, options))
      ))
    );
    for (const item of serial) {
      results.push(await this.executePrepared(item, model, options));
    }
    return results;
  }

  formatSkillContext(summaries: Array<{
    name: string;
    description: string;
    allowedToolsList: string[];
  }>): string {
    return summaries
      .map(
        (skill) =>
          `- ${skill.name}: ${skill.description} (tools: ${skill.allowedToolsList.join(", ") || "none"})`
      )
      .join("\n");
  }
}
