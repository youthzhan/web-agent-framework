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
import type { JsonValue } from "../schemas/json.js";
import {
  SkillToolPlanSchema,
  type PreparedSkillExecution,
  type SkillPlanItem,
  type LoadedSkill,
  type SkillOperation,
  type SkillOperationParameter
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
    const toolPlan = this.deduplicateToolPlan(
      await this.createToolPlan({
        skill,
        plan,
        model,
        toolNames
      })
    );

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
    const confirmations = highRiskCalls.map((highRiskCall) => {
      const tool = this.registry.getRequired(highRiskCall.toolName);
      const args = tool.argsSchema.parse(highRiskCall.args);
      return HumanConfirmationRecordSchema.parse({
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
    });
    const confirmation = confirmations[0];

    if (confirmation) {
      return {
        skill,
        input: plan.input,
        mode: plan.mode,
        reason: plan.reason,
        toolPlan,
        requiresConfirmation: true,
        confirmation,
        confirmations
      };
    }

    return {
      skill,
      input: plan.input,
      mode: plan.mode,
      reason: plan.reason,
      toolPlan,
      requiresConfirmation: false,
      confirmations: []
    };
  }

  async executePrepared(
    prepared: PreparedSkillExecution,
    model: ModelAdapter,
    options: { approvedHighRiskToolCallIds: readonly string[] }
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
          approvedHighRiskToolCallIds: options.approvedHighRiskToolCallIds,
          skillName: prepared.skill.name,
          executionMode: prepared.toolPlan.mode
        }
      );
      toolResults.push(...results.map((item) => item.result));
    }

    let output: string;
    if (!this.env.SKILL_SUMMARY_ENABLED) {
      output = this.createSummaryFallbackOutput(prepared.skill.name, toolResults);
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "skill_summary_skipped",
          node: "skill_engine",
          detail: {
            skillName: prepared.skill.name,
            reason: "disabled_to_reduce_latency",
            toolCount: toolResults.length
          }
        }
      });
    } else {
      try {
      const summarized = await model.invokeText(
        model.helperMessages(
          [
            "You are a skill result synthesizer.",
            `Skill instructions:\n${prepared.skill.instructions}`,
            "Use the tool results and user task to produce concise, factual output.",
            "Do not claim an action succeeded unless a tool result proves it."
          ].join("\n"),
          JSON.stringify({ task: prepared.input, toolResults })
        ),
        {
          operation: `skill_summarize:${prepared.skill.name}`,
          timeoutMs: this.env.SKILL_SUMMARY_TIMEOUT_MS
        }
      );
      output = summarized.text;
      } catch (error) {
      if (
        !(error instanceof AppError) ||
        !["MODEL_TIMEOUT", "MODEL_ERROR"].includes(error.code)
      ) {
        throw error;
      }
      // Tool results are already validated execution facts. Retain them when
      // the optional per-Skill prose summary fails; the final Agent node still
      // receives these facts and can produce the user-facing answer.
      output = this.createSummaryFallbackOutput(prepared.skill.name, toolResults);
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "skill_summary_fallback",
          node: "skill_engine",
          detail: {
            skillName: prepared.skill.name,
            reason:
              error.code === "MODEL_TIMEOUT"
                ? "model_timeout"
                : "model_error",
            toolCount: toolResults.length
          }
        }
      });
      this.logger.warn(
        {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          skillName: prepared.skill.name,
          fallbackReason: error.code,
          toolCount: toolResults.length
        },
        "skill_summary_fallback"
      );
      }
    }

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
      output,
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
      item.confirmations.length > 0
        ? item.confirmations
        : item.confirmation
          ? [item.confirmation]
          : []
    );
    const confirmation = confirmations[0];
    if (confirmation) {
      await this.activateConfirmation(confirmation);
    }
    return prepared;
  }

  /** Persists and emits one active item from the checkpointed approval queue. */
  async activateConfirmation(
    confirmation: z.infer<typeof HumanConfirmationRecordSchema>
  ): Promise<void> {
    const context = getRuntimeContext();
    await this.threadStore.setPendingConfirmation(context.threadId, confirmation);
    emitSseEvent("need_human_confirm", {
      requestId: context.requestId,
      threadId: context.threadId,
      userId: context.userId,
      data: confirmation
    });
  }

  async executeManyPrepared(
    prepared: PreparedSkillExecution[],
    model: ModelAdapter,
    options: { approvedHighRiskToolCallIds: readonly string[] }
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
    metadata?: Record<string, string> | undefined;
  }>): string {
    return summaries
      .map((skill) => {
        const metadata = Object.entries(skill.metadata ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}`)
          .join(", ");
        return `- ${skill.name}: ${skill.description} (tools: ${skill.allowedToolsList.join(", ") || "none"}; triggers: ${skill.triggers.join(", ") || "none"}; metadata: ${metadata || "none"})`;
      })
      .join("\n");
  }

  private async createToolPlan(input: {
    skill: LoadedSkill;
    plan: SkillPlanItem;
    model: ModelAdapter;
    toolNames: string;
  }): Promise<z.infer<typeof SkillToolPlanSchema>> {
    const deterministicPlan =
      this.env.SKILL_DETERMINISTIC_TOOL_PLAN_ENABLED
        ? this.createDeclaredToolPlan(input.skill, input.plan.input)
        : undefined;
    if (deterministicPlan) {
      const context = getRuntimeContext();
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "skill_planning_deterministic",
          node: "skill_engine",
          detail: {
            skillName: input.skill.name,
            toolMode: deterministicPlan.mode,
            toolCount: deterministicPlan.calls.length
          }
        }
      });
      this.logger.info(
        {
          requestId: context.requestId,
          threadId: context.threadId,
          userId: context.userId,
          skillName: input.skill.name,
          toolMode: deterministicPlan.mode,
          toolCount: deterministicPlan.calls.length
        },
        "skill_tool_plan_deterministic"
      );
      return deterministicPlan;
    }

    try {
      return await input.model.invokeJson(
        input.model.helperMessages(
          [
            "You are a skill execution planner.",
            `Skill name: ${input.skill.name}`,
            `Skill metadata: ${JSON.stringify(input.skill.metadata ?? {})}`,
            `Skill declared operations: ${JSON.stringify(input.skill.operations ?? [])}`,
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
        !["MODEL_TIMEOUT", "MODEL_ERROR"].includes(error.code)
      ) {
        throw error;
      }

      const fallback = this.createDeclaredToolPlan(
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
            reason:
              error.code === "MODEL_TIMEOUT"
                ? "model_timeout"
                : "invalid_model_response",
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
          fallbackReason: error.code,
          toolMode: fallback.mode,
          toolCount: fallback.calls.length
        },
        "skill_tool_plan_fallback"
      );
      return fallback;
    }
  }

  /**
   * Compile Skill-owned low-ambiguity operations first. The normal model
   * planner remains responsible for all other tool plans, including arbitrary
   * parameter synthesis and multi-step decisions.
   */
  private createDeclaredToolPlan(
    skill: LoadedSkill,
    input: string
  ): z.infer<typeof SkillToolPlanSchema> | undefined {
    const mode = /\bparallel\b|\u5e76\u884c|\u540c\u65f6|\u72ec\u7acb/i.test(input)
      ? "parallel"
      : "serial";

    for (const operation of skill.operations ?? []) {
      const operationPlan = this.compileDeclaredOperation(
        skill,
        operation,
        input,
        mode
      );
      if (operationPlan) {
        return operationPlan;
      }
    }

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

  private compileDeclaredOperation(
    skill: LoadedSkill,
    operation: SkillOperation,
    input: string,
    requestedMode: "serial" | "parallel"
  ): z.infer<typeof SkillToolPlanSchema> | undefined {
    if (!this.matchesDeclaredOperation(operation, input)) {
      return undefined;
    }

    const compiled = this.compileOperationArguments(operation, input);
    if (!compiled) {
      return undefined;
    }

    const operationMode = operation.mode ?? requestedMode;
    const calls = operation.preflight.map((preflight, index) => ({
      toolName: preflight.tool,
      toolCallId: `${skill.name}:${operation.id}:preflight:${index}:${randomUUID()}`,
      args: {
        path: preflight.path,
        method: preflight.method,
        query: preflight.query,
        ...(preflight.body !== undefined ? { body: preflight.body } : {})
      }
    }));
    calls.push({
      toolName: operation.tool,
      toolCallId: `${skill.name}:${operation.id}:${randomUUID()}`,
      args: {
        path: compiled.path,
        method: operation.method,
        query: compiled.query,
        ...(compiled.body !== undefined ? { body: compiled.body } : {})
      }
    });
    return SkillToolPlanSchema.parse({ mode: operationMode, calls });
  }

  private matchesDeclaredOperation(
    operation: SkillOperation,
    input: string
  ): boolean {
    const matchesAny = (terms: readonly string[]) =>
      terms.length === 0 || terms.some((term) => this.matchesOperationTerm(input, term));
    return (
      matchesAny(operation.intent) &&
      !operation.exclude.some((term) => this.matchesOperationTerm(input, term)) &&
      matchesAny(operation.requiresAny)
    );
  }

  private matchesOperationTerm(input: string, term: string): boolean {
    try {
      return new RegExp(term, "i").test(input);
    } catch {
      return input.toLocaleLowerCase().includes(term.toLocaleLowerCase());
    }
  }

  private compileOperationArguments(
    operation: SkillOperation,
    input: string
  ): { path: string; query: Record<string, string>; body?: JsonValue } | undefined {
    const query: Record<string, string> = { ...operation.query };
    let path = operation.path;
    let body: JsonValue | undefined = operation.body === undefined
      ? undefined
      : structuredClone(operation.body);

    for (const parameter of operation.parameters) {
      const values = this.extractOperationParameter(parameter, input);
      const value = values.length > 0
        ? values.join(parameter.separator)
        : parameter.value ?? this.readEnvValue(parameter.env);
      if (value === undefined || value === "") {
        if (parameter.required) {
          return undefined;
        }
        continue;
      }

      if (parameter.target === "query") {
        query[parameter.name] = value;
      } else if (parameter.target === "path") {
        path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(value));
      } else {
        if (body === undefined) {
          body = {};
        }
        if (!isRecord(body)) {
          return undefined;
        }
        setNestedValue(body, parameter.name, value);
      }
    }

    return { path, query, ...(body !== undefined ? { body } : {}) };
  }

  private extractOperationParameter(
    parameter: SkillOperationParameter,
    input: string
  ): string[] {
    if (!parameter.pattern) {
      return [];
    }
    try {
      const flags = parameter.repeat ? "gi" : "i";
      const expression = new RegExp(parameter.pattern, flags);
      if (parameter.repeat) {
        return [...input.matchAll(expression)]
          .map((match) => match[parameter.group] ?? match[0])
          .filter((value): value is string => Boolean(value));
      }
      const match = expression.exec(input);
      const value = match?.[parameter.group] ?? match?.[0];
      return value ? [value] : [];
    } catch {
      return [];
    }
  }

  private readEnvValue(name?: string): string | undefined {
    if (!name) {
      return undefined;
    }
    const value = (this.env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private extractRelativeFilePaths(input: string): string[] {
    const matches = input.matchAll(
      /(?:^|[\s"'\x60:;,([\{\uFF1A\uFF1B\uFF0C\u3002\u3001\uFF08\u3010\u300A])((?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?=$|[\s"'\x60:;,.!?\uFF1A\uFF1B\uFF0C\u3002\u3001\uFF09\u3011\u300B)\]}])/g
    );
    return [...new Set(
      [...matches]
        .map((match) => match[1]?.replaceAll("\\", "/"))
        .filter((path): path is string => Boolean(path))
    )].slice(0, 5);
  }

  private extractHttpUrls(input: string): string[] {
    const matches = input.matchAll(
      /https?:\/\/[^\s<>"'\u3002\u3001\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300B]+/gi
    );
    return [...new Set(
      [...matches]
        .map((match) => match[0]?.replace(/[.,!?\u3002\uff0c]+$/, ""))
        .filter((url): url is string => Boolean(url))
    )].slice(0, 5);
  }

  /**
   * Identical calls add no information and can create duplicate approvals or
   * duplicate external side effects. Preserve the first call and its ID.
   */
  private deduplicateToolPlan(
    plan: z.infer<typeof SkillToolPlanSchema>
  ): z.infer<typeof SkillToolPlanSchema> {
    const seen = new Set<string>();
    return SkillToolPlanSchema.parse({
      ...plan,
      calls: plan.calls.filter((call) => {
        const signature = JSON.stringify([call.toolName, call.args]);
        if (seen.has(signature)) {
          return false;
        }
        seen.add(signature);
        return true;
      })
    });
  }

  private createSummaryFallbackOutput(
    skillName: string,
    toolResults: unknown[]
  ): string {
    return [
      `Skill ${skillName} completed its tool calls, but its intermediate model summary was unavailable.`,
      "Verified tool results:",
      JSON.stringify(toolResults)
    ].join("\n");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setNestedValue(
  target: Record<string, unknown>,
  name: string,
  value: string
): void {
  const segments = name.split(".").filter(Boolean);
  if (segments.length === 0) {
    return;
  }
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}
