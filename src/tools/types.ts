import { z } from "zod";
import { JsonValueSchema } from "../schemas/json.js";

export const ToolRiskSchema = z.enum(["low", "medium", "high"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolExecutionModeSchema = z.enum(["serial", "parallel"]);
export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;

export const ToolCallSchema = z.object({
  toolName: z.string(),
  toolCallId: z.string(),
  args: JsonValueSchema
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export type ToolExecutionContext = {
  requestId: string;
  threadId: string;
  userId: string;
  signal?: AbortSignal;
};

export type AgentTool<TArgs extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  argsSchema: TArgs;
  risk: ToolRisk;
  execute(
    args: z.infer<TArgs>,
    context: ToolExecutionContext
  ): Promise<unknown>;
};

export type ToolRegistry = {
  register(tool: AgentTool): void;
  get(name: string): AgentTool | undefined;
  getRequired(name: string): AgentTool;
  list(): AgentTool[];
};
