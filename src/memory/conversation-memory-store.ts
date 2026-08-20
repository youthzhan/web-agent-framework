import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import type { PersistenceStore } from "../persistence/store.js";

/**
 * `coveredMessageCount` is a raw MessageStore list offset. Messages before
 * this offset have been represented in `summary`; newer messages remain in
 * their original form and can still be shown in the recent-context window.
 */
export const ConversationMemoryRecordSchema = z.object({
  threadId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  summary: z.string().min(1).max(20_000),
  coveredMessageCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});

export type ConversationMemoryRecord = z.infer<
  typeof ConversationMemoryRecordSchema
>;

export class ConversationMemoryStore {
  constructor(
    private readonly persistence: PersistenceStore,
    private readonly env: AppEnv
  ) {}

  async get(threadId: string): Promise<ConversationMemoryRecord | undefined> {
    const raw = await this.persistence.get(this.key(threadId));
    return raw
      ? ConversationMemoryRecordSchema.parse(JSON.parse(raw))
      : undefined;
  }

  async save(
    input: Omit<ConversationMemoryRecord, "updatedAt"> & {
      updatedAt?: string;
    }
  ): Promise<ConversationMemoryRecord> {
    const record = ConversationMemoryRecordSchema.parse({
      ...input,
      updatedAt: input.updatedAt ?? new Date().toISOString()
    });
    await this.persistence.set(
      this.key(record.threadId),
      JSON.stringify(record),
      "EX",
      this.env.MESSAGE_TTL_SECONDS
    );
    return record;
  }

  private key(threadId: string): string {
    return `conversation-memory:${threadId}`;
  }
}
