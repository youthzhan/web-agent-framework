import { z } from "zod";
import { HumanConfirmationRecordSchema } from "../schemas/human-confirmation.js";
import { JsonValueSchema } from "../schemas/json.js";

const RoutingTermsSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(/[,，;；|\n]+/)
          .map((term) => term.trim())
          .filter(Boolean)
      : value,
  z.array(z.string().min(1).max(80)).default([])
);

const OperationTermsSchema = z.preprocess(
  (value) => typeof value === "string" ? [value] : value,
  z.array(z.string().min(1).max(200)).default([])
);

export const SkillOperationParameterSchema = z.object({
  name: z.string().min(1).max(80),
  target: z.enum(["query", "body", "path"]).default("query"),
  pattern: z.string().min(1).max(500).optional(),
  group: z.number().int().nonnegative().max(20).default(1),
  repeat: z.boolean().default(false),
  separator: z.string().max(10).default(","),
  env: z.string().min(1).max(100).optional(),
  value: z.string().max(500).optional(),
  required: z.boolean().default(false)
});

export type SkillOperationParameter = z.infer<
  typeof SkillOperationParameterSchema
>;

export const SkillOperationCallSchema = z.object({
  tool: z.string().min(1).max(80),
  method: z.string().regex(/^[A-Z]+$/).default("GET"),
  path: z.string().startsWith("/").max(1_000),
  query: z.record(z.string(), z.string()).default({}),
  body: JsonValueSchema.optional()
});

export const SkillOperationSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  intent: OperationTermsSchema,
  exclude: OperationTermsSchema,
  requiresAny: OperationTermsSchema,
  tool: z.string().min(1).max(80),
  method: z.string().regex(/^[A-Z]+$/),
  path: z.string().startsWith("/").max(1_000),
  query: z.record(z.string(), z.string()).default({}),
  body: JsonValueSchema.optional(),
  parameters: z.array(SkillOperationParameterSchema).max(30).default([]),
  preflight: z.array(SkillOperationCallSchema).max(10).default([]),
  mode: z.enum(["serial", "parallel"]).optional()
});

export type SkillOperation = z.infer<typeof SkillOperationSchema>;

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  allowedTools: z.string().optional(),
  triggers: z.array(z.string().min(1).max(80)).max(100).default([]),
  // Accept both YAML arrays and the comma-delimited strings used by the
  // independently published M4 Skill pack.
  routingKeywords: RoutingTermsSchema.pipe(z.array(z.string().min(1).max(80)).max(80)),
  routingExcludes: RoutingTermsSchema.pipe(z.array(z.string().min(1).max(80)).max(40)),
  operations: z.array(SkillOperationSchema).max(100).optional(),
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

export const SkillMatchSchema = z.object({
  summary: SkillSummarySchema,
  source: z.enum(["explicit", "intent", "semantic"]),
  score: z.number().nonnegative(),
  position: z.number().int().nonnegative(),
  matchedTriggers: z.array(z.string()).default([])
});

export type SkillMatch = z.infer<typeof SkillMatchSchema>;

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
  // All pending approvals live in checkpointed state. Keep the singular field
  // for compatibility with checkpoints created before approval queues existed.
  confirmation: HumanConfirmationRecordSchema.optional(),
  confirmations: z.array(HumanConfirmationRecordSchema).default([])
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
