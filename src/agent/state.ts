import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import { AgentPlanSchema, PreparedSkillExecutionSchema } from "../skills/types.js";
import type { ModelProvider } from "../schemas/api.js";
import type { MessageRecord } from "../persistence/message-store.js";
import {
  HumanConfirmationDecisionSchema,
  type HumanConfirmationDecision,
  type HumanConfirmationRecord
} from "../schemas/human-confirmation.js";

export const AgentGraphInputSchema = z.object({
  requestId: z.string(),
  threadId: z.string().uuid(),
  userId: z.string(),
  message: z.string(),
  history: z.array(z.custom<MessageRecord>()).default([]),
  longTermMemory: z.string().default(""),
  modelProvider: z.enum(["openai", "openai-compatible", "anthropic"]),
  model: z.string().optional()
});

export type AgentGraphInput = z.infer<typeof AgentGraphInputSchema>;

export const SkillExecutionResultSchema = z.object({
  skillName: z.string(),
  output: z.string(),
  toolResults: z.array(z.unknown())
});

export type SkillExecutionResult = z.infer<typeof SkillExecutionResultSchema>;

export const AgentState = Annotation.Root({
  requestId: Annotation<string>(),
  threadId: Annotation<string>(),
  userId: Annotation<string>(),
  message: Annotation<string>(),
  history: Annotation<MessageRecord[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  longTermMemory: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => ""
  }),
  modelProvider: Annotation<ModelProvider>(),
  model: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  status: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "running"
  }),
  skillContext: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => ""
  }),
  plan: Annotation<z.infer<typeof AgentPlanSchema> | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  preparedSkills: Annotation<z.infer<typeof PreparedSkillExecutionSchema>[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  pendingConfirmation: Annotation<HumanConfirmationRecord | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  approvalDecision: Annotation<HumanConfirmationDecision | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  approvalDecisions: Annotation<HumanConfirmationDecision[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  skillResults: Annotation<SkillExecutionResult[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  finalOutput: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => ""
  }),
  error: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  })
});

export type AgentStateValue = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;

export const HumanDecisionSchema = HumanConfirmationDecisionSchema;
export type HumanDecision = HumanConfirmationDecision;
