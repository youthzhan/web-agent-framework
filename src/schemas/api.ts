import { z } from "zod";
import { JsonValueSchema } from "./json.js";

export const ModelProviderSchema = z.enum([
  "openai",
  "openai-compatible",
  "anthropic"
]);

export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(20_000),
  threadId: z.string().uuid().optional(),
  userId: z.string().min(1).max(128).default("anonymous"),
  modelProvider: ModelProviderSchema.optional(),
  model: z.string().min(1).max(128).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const HumanConfirmationSchema = z.object({
  threadId: z.string().uuid(),
  userId: z.string().min(1).max(128).default("anonymous"),
  confirmationId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().max(2_000).optional(),
  // 前端允许用户在确认前修正参数；仍会被目标工具的 Zod schema 二次校验。
  argsOverride: JsonValueSchema.optional(),
  modelProvider: ModelProviderSchema.optional(),
  model: z.string().min(1).max(128).optional()
});

export type HumanConfirmation = z.infer<typeof HumanConfirmationSchema>;

export const ThreadParamsSchema = z.object({
  threadId: z.string().uuid()
});
