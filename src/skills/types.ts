import { z } from "zod";
import { HumanConfirmationRecordSchema } from "../schemas/human-confirmation.js";
import { JsonValueSchema } from "../schemas/json.js";

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  allowedTools: z.string().optional(),
  compatibility: z.string().optional(),
  license: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional()
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const SkillSummarySchema = SkillFrontmatterSchema.extend({
  directory: z.string(),
  filePath: z.string(),
  allowedToolsList: z.array(z.string()).default([])
});

export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const LoadedSkillSchema = SkillSummarySchema.extend({
  instructions: z.string().min(1)
});

export type LoadedSkill = z.infer<typeof LoadedSkillSchema>;

export const SkillPlanItemSchema = z.object({
  skillName: z.string(),
  reason: z.string(),
  mode: z.enum(["serial", "parallel"]),
  input: z.string()
});

export type SkillPlanItem = z.infer<typeof SkillPlanItemSchema>;

export const SkillToolCallSchema = z.object({
  toolName: z.string(),
  toolCallId: z.string(),
  args: JsonValueSchema
});

export const SkillToolPlanSchema = z.object({
  mode: z.enum(["serial", "parallel"]),
  calls: z.array(SkillToolCallSchema).default([])
});

export const PreparedSkillExecutionSchema = z.object({
  skill: LoadedSkillSchema,
  input: z.string(),
  mode: z.enum(["serial", "parallel"]),
  reason: z.string(),
  toolPlan: SkillToolPlanSchema,
  requiresConfirmation: z.boolean().default(false),
  confirmation: HumanConfirmationRecordSchema.optional()
});

export type PreparedSkillExecution = z.infer<
  typeof PreparedSkillExecutionSchema
>;

export const AgentPlanSchema = z.object({
  response: z.string().optional(),
  skills: z.array(SkillPlanItemSchema).default([]),
  directAnswer: z.boolean().default(false)
});

export type AgentPlan = z.infer<typeof AgentPlanSchema>;
