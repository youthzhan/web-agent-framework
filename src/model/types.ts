import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { ModelProviderSchema } from "../schemas/api.js";

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export type ModelSelection = {
  provider: z.infer<typeof ModelProviderSchema>;
  model?: string;
};

export type ChatModelInstance = {
  invoke(
    input: BaseMessage[],
    options?: Record<string, unknown>
  ): Promise<BaseMessage>;
  stream?(
    input: BaseMessage[],
    options?: Record<string, unknown>
  ): Promise<AsyncIterable<BaseMessage>>;
};

export type JsonInvokeOptions = {
  operation: string;
  signal?: AbortSignal;
};

export type TextInvokeOptions = {
  operation: string;
  signal?: AbortSignal;
};
