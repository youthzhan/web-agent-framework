import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../common/errors.js";
import { emitSseEvent, getRuntimeContext } from "../common/run-context.js";
import type { AppLogger } from "../common/logger.js";
import type { AppEnv } from "../config/env.js";
import type { ModelAdapter } from "../model/model-adapter.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolCall } from "../tools/types.js";
import type { ToolRegistry } from "../tools/types.js";
import type { ThreadStore } from "../persistence/thread-store.js";
import { HumanConfirmationRecordSchema } from "../schemas/human-confirmation.js";
import {
  SkillToolPlanSchema,
  type PreparedSkillExecution,
  type SkillPlanItem,
  type LoadedSkill
} from "./types.js";
import type { SkillLoader } from "./skill-loader.js";
import { runByPlannedMode } from "./scheduling.js";

const ExecutionResultSchema = z.object({
  skillName: z.string(),
  output: z.string(),
  toolResults: z.array(z.unknown())
});

export type SkillExecutionResult = z.infer<typeof ExecutionResultSchema>;

export class SkillEngine {
  constructor(
    private readonly env: AppEnv,
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
        detail: { skillName: skill.name, mode: plan.mode }
      }
    });

    const allowedTools = skill.allowedToolsList;
    const toolNames = allowedTools.length > 0 ? allowedTools.join(", ") : "none";
    const toolPlan = await this.createToolPlan({
      skill,
      plan,
      model,
      toolNames
    });

    for (const call of toolPlan.calls) {
      if (!allowedTools.includes(call.toolName)) {
        throw new Error(
          `Skill ${skill.name} attempted unregistered tool ${call.toolName}`
        );
      }
    }

    const highRiskCalls = toolPlan.calls.filter((call) => {
      const tool = this.registry.getRequired(call.toolName);
      return tool.risk !== "low";
    });
    if (highRiskCalls.length > 1) {
      throw new AppError(
        "TOOL_ERROR",
        `Skill ${skill.name} may request only one high-risk tool call per approval step`,
        {
          statusCode: 409,
          details: {
            toolCallIds: highRiskCalls.map((call) => call.toolCallId)
          }
        }
      );
    }
    const highRiskCall = highRiskCalls[0];

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
    emitSseEvent("state_update", {
      requestId: context.requestId,
      threadId: context.threadId,
      userId: context.userId,
      data: {
        status: "skill_executing",
        node: "skill_engine",
        detail: {
          skillName: prepared.skill.name,
          skillMode: prepared.mode,
          toolMode: prepared.toolPlan.mode,
          toolCount: prepared.toolPlan.calls.length
        }
      }
    });
    const toolResults: unknown[] = [];
    if (prepared.toolPlan.calls.length > 0) {
      const calls: ToolCall[] = prepared.toolPlan.calls;
      const results = await this.toolExecutor.executeCalls(
        calls,
        prepared.toolPlan.mode,
        {
          allowHighRisk: options.allowHighRisk,
          skillName: prepared.skill.name,
          executionMode: prepared.toolPlan.mode
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
    const prepared = await runByPlannedMode(plans, async (plan) => {
      return await this.prepare(plan, model);
    });
    const confirmations = prepared.flatMap((item) =>
      item.confirmation ? [item.confirmation] : []
    );
    if (confirmations.length > 1) {
      throw new AppError(
        "TOOL_ERROR",
        "A task may request only one high-risk tool call per approval step",
        {
          statusCode: 409,
          details: {
            confirmationIds: confirmations.map((item) => item.confirmationId)
          }
        }
      );
    }
    const confirmation = confirmations[0];
    if (confirmation) {
      const context = getRuntimeContext();
      await this.threadStore.setPendingConfirmation(
        context.threadId,
        confirmation
      );
      emitSseEvent("need_human_confirm", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: confirmation
      });
    }
    return prepared;
  }

  async executeManyPrepared(
    prepared: PreparedSkillExecution[],
    model: ModelAdapter,
    options: { allowHighRisk: boolean }
  ): Promise<SkillExecutionResult[]> {
    return await runByPlannedMode(prepared, async (item) => {
      return await this.executePrepared(item, model, options);
    });
  }

  formatSkillContext(summaries: Array<{
    name: string;
    description: string;
    allowedToolsList: string[];
    triggers: string[];
  }>): string {
    return summaries
      .map(
        (skill) =>
          `- ${skill.name}: ${skill.description} (tools: ${skill.allowedToolsList.join(", ") || "none"}; triggers: ${skill.triggers.join(", ") || "none"})`
      )
      .join("\n");
  }

  private async createToolPlan(input: {
    skill: LoadedSkill;
    plan: SkillPlanItem;
    model: ModelAdapter;
    toolNames: string;
  }): Promise<z.infer<typeof SkillToolPlanSchema>> {
    try {
      return await input.model.invokeJson(
        input.model.helperMessages(
          [
            "You are a skill execution planner.",
            `Skill name: ${input.skill.name}`,
            `Skill instructions:\n${input.skill.instructions}`,
            `Available skill tools: ${input.toolNames}`,
            "Only choose tools listed in allowedTools.",
            "Return a tool execution plan. Use parallel only when calls are independent.",
            'Return JSON shaped exactly as: {"mode":"serial|parallel","calls":[{"toolName":"allowed-tool-name","toolCallId":"unique-id","args":{}}]}.'
          ].join("\n"),
          input.plan.input
        ),
        SkillToolPlanSchema,
        {
          operation: `skill_plan:${input.skill.name}`,
          timeoutMs: this.env.SKILL_PLAN_TIMEOUT_MS
        }
      );
    } catch (error) {
      if (
        !this.env.SKILL_TOOL_PLAN_FALLBACK_ENABLED ||
        !(error instanceof AppError) ||
        error.code !== "MODEL_TIMEOUT"
      ) {
        throw error;
      }

      const fallback = this.createExplicitToolPlan(
        input.skill,
        input.plan.input
      );
      if (!fallback) {
        throw error;
      }

      const context = getRuntimeContext();
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "skill_planning_fallback",
          node: "skill_engine",
          detail: {
            skillName: input.skill.name,
            reason: "model_timeout",
            toolMode: fallback.mode,
            toolCount: fallback.calls.length
          }
        }
      });
      this.logger.warn(
        {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          skillName: input.skill.name,
          toolMode: fallback.mode,
          toolCount: fallback.calls.length
        },
        "skill_tool_plan_timeout_fallback"
      );
      return fallback;
    }
  }

  /**
   * Timeout fallback intentionally accepts only explicit, low-ambiguity
   * parameters. The normal model planner remains responsible for all other
   * tool plans, including any parameter synthesis or multi-step decisions.
   */
  private createExplicitToolPlan(
    skill: LoadedSkill,
    input: string
  ): z.infer<typeof SkillToolPlanSchema> | undefined {
    const mode = /\bparallel\b|\u5e76\u884c|\u540c\u65f6|\u72ec\u7acb/i.test(input)
      ? "parallel"
      : "serial";

    if (skill.allowedToolsList.includes("file_read")) {
      const paths = this.extractRelativeFilePaths(input);
      if (paths.length > 0) {
        return SkillToolPlanSchema.parse({
          mode,
          calls: paths.map((filePath) => ({
            toolName: "file_read",
            toolCallId: `${skill.name}:fallback:${randomUUID()}`,
            args: { path: filePath }
          }))
        });
      }
    }

    if (skill.allowedToolsList.includes("http_request")) {
      const urls = this.extractHttpUrls(input);
      if (urls.length > 0) {
        return SkillToolPlanSchema.parse({
          mode,
          calls: urls.map((url) => ({
            toolName: "http_request",
            toolCallId: `${skill.name}:fallback:${randomUUID()}`,
            args: { url, method: "GET" }
          }))
        });
      }
    }

    return undefined;
  }

  private extractRelativeFilePaths(input: string): string[] {
    const matches = input.matchAll(
      /(?:^|[\s"'\x60])((?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?=$|[\s"'\x60,.!?\u3002\uff0c])/g
    );
    return [...new Set(
      [...matches]
        .map((match) => match[1]?.replaceAll("\\", "/"))
        .filter((path): path is string => Boolean(path))
    )].slice(0, 5);
  }

  private extractHttpUrls(input: string): string[] {
    const matches = input.matchAll(/https?:\/\/[^\s<>"']+/gi);
    return [...new Set(
      [...matches]
        .map((match) => match[0]?.replace(/[.,!?\u3002\uff0c]+$/, ""))
        .filter((url): url is string => Boolean(url))
    )].slice(0, 5);
  }
}
