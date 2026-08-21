import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import type { PersistenceStore } from "./store.js";
import {
  HumanConfirmationRecordSchema,
  type HumanConfirmationRecord
} from "../schemas/human-confirmation.js";

const OpenAiResponseStateSchema = z.object({
  responseId: z.string().min(1),
  // `openai` is the migration default for state written before compatible
  // Responses API support was added.
  provider: z.enum(["openai", "openai-compatible"]).default("openai"),
  model: z.string().min(1).max(128),
  updatedAt: z.string().datetime()
});

export type OpenAiResponseState = z.infer<typeof OpenAiResponseStateSchema>;

export const ThreadRecordSchema = z.object({
  threadId: z.string().uuid(),
  userId: z.string(),
  status: z.enum([
    "idle",
    "running",
    "waiting_human_confirm",
    "completed",
    "failed"
  ]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  pendingConfirmation: HumanConfirmationRecordSchema.optional(),
  // This is server-side state for OpenAI Responses API continuation. It is
  // separate from the durable application-owned message history.
  openAiResponseState: OpenAiResponseStateSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

export class ThreadStore {
  constructor(
    private readonly redis: PersistenceStore,
    private readonly env: AppEnv
  ) {}

  async upsert(input: {
    threadId: string;
    userId: string;
    status: ThreadRecord["status"];
    metadata?: Record<string, unknown>;
  }): Promise<ThreadRecord> {
    const existing = await this.get(input.threadId);
    const now = new Date().toISOString();
    const record = ThreadRecordSchema.parse({
      threadId: input.threadId,
      userId: input.userId,
      status: input.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      pendingConfirmation: existing?.pendingConfirmation,
      openAiResponseState: existing?.openAiResponseState,
      metadata: input.metadata ?? existing?.metadata
    });
    await this.save(record);
    return record;
  }

  async setStatus(
    threadId: string,
    status: ThreadRecord["status"]
  ): Promise<void> {
    const existing = await this.getRequired(threadId);
    await this.save({
      ...existing,
      status,
      updatedAt: new Date().toISOString()
    });
  }

  async setPendingConfirmation(
    threadId: string,
    pendingConfirmation: HumanConfirmationRecord
  ): Promise<HumanConfirmationRecord> {
    const existing = await this.getRequired(threadId);
    const pending = HumanConfirmationRecordSchema.parse(pendingConfirmation);
    await this.save({
      ...existing,
      status: "waiting_human_confirm",
      pendingConfirmation: pending,
      updatedAt: new Date().toISOString()
    });
    return pending;
  }

  async clearPendingConfirmation(threadId: string): Promise<void> {
    const existing = await this.getRequired(threadId);
    const { pendingConfirmation: _pendingConfirmation, ...rest } = existing;
    await this.save({
      ...rest,
      status: "running",
      updatedAt: new Date().toISOString()
    });
  }

  /** Persists only the opaque response id needed for the next vendor turn. */
  async setOpenAiResponseState(
    threadId: string,
    input: Omit<OpenAiResponseState, "updatedAt">
  ): Promise<void> {
    const existing = await this.getRequired(threadId);
    const now = new Date().toISOString();
    await this.save({
      ...existing,
      openAiResponseState: OpenAiResponseStateSchema.parse({
        ...input,
        updatedAt: now
      }),
      updatedAt: now
    });
  }

  async get(threadId: string): Promise<ThreadRecord | undefined> {
    const raw = await this.redis.get(this.key(threadId));
    if (!raw) {
      return undefined;
    }
    return ThreadRecordSchema.parse(JSON.parse(raw));
  }

  private async getRequired(threadId: string): Promise<ThreadRecord> {
    const thread = await this.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  private async save(record: ThreadRecord): Promise<void> {
    await this.redis.set(
      this.key(record.threadId),
      JSON.stringify(record),
      "EX",
      this.env.MESSAGE_TTL_SECONDS
    );
  }

  private key(threadId: string): string {
    return `threads:${threadId}`;
  }
}
