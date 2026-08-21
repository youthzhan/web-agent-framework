import { randomUUID } from "node:crypto";
import { AppError } from "../common/errors.js";
import { emitSseEvent, getRuntimeContext } from "../common/run-context.js";
import type { AppLogger } from "../common/logger.js";
import type { ThreadStore } from "../persistence/thread-store.js";
import { HumanConfirmationRecordSchema } from "../schemas/human-confirmation.js";
import { JsonValueSchema } from "../schemas/json.js";
import type { AgentTool, ToolCall, ToolExecutionMode } from "./types.js";
import type { ToolRegistry } from "./types.js";

type ToolExecutionOptions = {
  approvedHighRiskToolCallIds?: readonly string[];
  skillName: string;
  executionMode: ToolExecutionMode;
};

export class HumanConfirmationRequired extends Error {
  constructor(
    public readonly confirmationId: string,
    public readonly tool: AgentTool,
    public readonly toolCall: ToolCall,
    public readonly reason: string
  ) {
    super(`Human confirmation required for tool ${tool.name}`);
    this.name = "HumanConfirmationRequired";
  }
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly threadStore: ThreadStore,
    private readonly logger: AppLogger
  ) {}

  async executeCalls(
    calls: ToolCall[],
    mode: ToolExecutionMode,
    options: ToolExecutionOptions
  ): Promise<Array<{ call: ToolCall; result: unknown }>> {
    const normalizedCalls = calls.map((call) => ({
      ...call,
      toolCallId: call.toolCallId || randomUUID()
    }));

    if (mode === "parallel") {
      return await Promise.all(
        normalizedCalls.map((call) => this.executeOne(call, options))
      );
    }
    const results: Array<{ call: ToolCall; result: unknown }> = [];
    for (const call of normalizedCalls) {
      results.push(await this.executeOne(call, options));
    }
    return results;
  }

  private async executeOne(
    call: ToolCall,
    options: ToolExecutionOptions
  ): Promise<{ call: ToolCall; result: unknown }> {
    const context = getRuntimeContext();
    const tool = this.registry.getRequired(call.toolName);
    const parsedArgs = tool.argsSchema.parse(call.args);
    const checkpointArgs = JsonValueSchema.parse(parsedArgs);
    const highRiskApproved =
      tool.risk === "low" ||
      options.approvedHighRiskToolCallIds?.includes(call.toolCallId) === true;

    emitSseEvent("tool_call", {
      requestId: context.requestId,
      threadId: context.threadId,
      userId: context.userId,
      data: {
        toolName: tool.name,
        toolCallId: call.toolCallId,
        mode: options.executionMode,
        risk: tool.risk,
        requiresConfirmation: !highRiskApproved,
        args: checkpointArgs
      }
    });
    this.logger.info(
      {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        toolName: tool.name,
        toolCallId: call.toolCallId,
        executionMode: options.executionMode,
        risk: tool.risk
      },
      "tool_call"
    );

    if (!highRiskApproved) {
      const confirmationId = randomUUID();
      const reason = `Tool ${tool.name} is classified as ${tool.risk} risk`;
      const confirmation = HumanConfirmationRecordSchema.parse({
        confirmationId,
        threadId: context.threadId,
        userId: context.userId,
        skillName: options.skillName,
        toolName: tool.name,
        toolCallId: call.toolCallId,
        risk: tool.risk,
        args: checkpointArgs,
        reason,
        createdAt: new Date().toISOString()
      });
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
      throw new HumanConfirmationRequired(
        confirmationId,
        tool,
        { ...call, args: checkpointArgs },
        reason
      );
    }

    try {
      const result = await tool.execute(parsedArgs, {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId
      });
      emitSseEvent("tool_result", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          toolName: tool.name,
          toolCallId: call.toolCallId,
          ok: true,
          result
        }
      });
      this.logger.info(
        {
          requestId: context.requestId,
          threadId: context.threadId,
          toolName: tool.name,
          toolCallId: call.toolCallId
        },
        "tool_result"
      );
      return { call: { ...call, args: checkpointArgs }, result };
    } catch (error) {
      const normalized =
        error instanceof AppError
          ? error
          : new AppError("TOOL_ERROR", "Tool execution failed", { cause: error });
      emitSseEvent("tool_result", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          toolName: tool.name,
          toolCallId: call.toolCallId,
          ok: false,
          error: normalized.message
        }
      });
      throw normalized;
    }
  }
}
