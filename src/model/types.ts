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
  timeoutMs?: number;
  /** Optional provider output cap for latency-sensitive final answers. */
  maxOutputTokens?: number;
};

export type TextInvokeOptions = {
  operation: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional provider output cap for latency-sensitive final answers. */
  maxOutputTokens?: number;
  /** Called once when the provider returns the first visible output token. */
  onFirstToken?: () => void;
  /**
   * Opt-in OpenAI Responses API conversation state. This is deliberately
   * supplied per call so planning and tool orchestration never contaminate the
   * user-facing vendor conversation chain.
   */
  responseState?: {
    previousResponseId?: string;
    onResponseStored: (responseId: string) => Promise<void>;
  };
};
