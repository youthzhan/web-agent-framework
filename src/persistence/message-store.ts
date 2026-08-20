import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import type { PersistenceStore } from "./store.js";

export const MessageRoleSchema = z.enum(["user", "assistant", "tool"]);

export const MessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  userId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type MessageRecord = z.infer<typeof MessageRecordSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export class MessageStore {
  constructor(
    private readonly redis: PersistenceStore,
    private readonly env: AppEnv
  ) {}

  async append(
    input: Omit<MessageRecord, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    }
  ): Promise<MessageRecord> {
    const record = MessageRecordSchema.parse({
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString()
    });

    const key = this.key(record.threadId);
    await this.redis.rpush(key, JSON.stringify(record));
    await this.redis.expire(key, this.env.MESSAGE_TTL_SECONDS);
    return record;
  }

  async getRecent(
    threadId: string,
    limit: number,
    roles: MessageRole[] = ["user", "assistant"]
  ): Promise<MessageRecord[]> {
    const raw = await this.redis.lrange(this.key(threadId), -limit, -1);
    return raw
      .map((item) => MessageRecordSchema.safeParse(JSON.parse(item)))
      .filter((item): item is { success: true; data: MessageRecord } => {
        return item.success && roles.includes(item.data.role);
      })
      .map((item) => item.data);
  }

  async list(threadId: string, limit = 100): Promise<MessageRecord[]> {
    const raw = await this.redis.lrange(this.key(threadId), -limit, -1);
    return raw
      .map((item) => MessageRecordSchema.safeParse(JSON.parse(item)))
      .filter((item): item is { success: true; data: MessageRecord } => {
        return item.success;
      })
      .map((item) => item.data);
  }

  private key(threadId: string): string {
    return `messages:${threadId}`;
  }
}
