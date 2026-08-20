import { z } from "zod";
import { JsonValueSchema } from "./json.js";

export const HumanConfirmationRiskSchema = z.enum(["medium", "high"]);

export const HumanConfirmationRecordSchema = z.object({
  confirmationId: z.string().min(1),
  threadId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  skillName: z.string().min(1).max(100),
  toolName: z.string().min(1).max(100),
  toolCallId: z.string().min(1).max(200),
  risk: HumanConfirmationRiskSchema,
  args: JsonValueSchema,
  reason: z.string().min(1).max(2_000),
  createdAt: z.string().datetime()
});

export type HumanConfirmationRecord = z.infer<
  typeof HumanConfirmationRecordSchema
>;

export const HumanConfirmationDecisionSchema = z.object({
  confirmationId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().max(2_000).optional(),
  argsOverride: JsonValueSchema.optional()
});

export type HumanConfirmationDecision = z.infer<
  typeof HumanConfirmationDecisionSchema
>;
