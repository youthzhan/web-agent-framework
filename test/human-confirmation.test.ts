import { describe, expect, it } from "vitest";
import { HumanConfirmationRecordSchema } from "../src/schemas/human-confirmation.js";
import { ThreadRecordSchema, ThreadStore } from "../src/persistence/thread-store.js";

class MemoryRedis {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }
}

describe("human confirmation persistence", () => {
  it("preserves the full confirmation record through Redis JSON storage", async () => {
    const redis = new MemoryRedis();
    const store = new ThreadStore(
      redis as never,
      { MESSAGE_TTL_SECONDS: 3_600 } as never
    );
    const threadId = "6f0e9e73-4fd8-48e3-a2b0-954cdb30f7fe";
    const confirmation = HumanConfirmationRecordSchema.parse({
      confirmationId: "file-review:call-01",
      threadId,
      userId: "user-42",
      skillName: "file-review",
      toolName: "http_request",
      toolCallId: "call-01",
      risk: "high",
      args: {
        url: "https://api.example.com/reports",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"reportId\":\"r-123\"}"
      },
      reason: "The request sends data to an external API.",
      createdAt: "2026-08-20T10:30:00.000Z"
    });

    await store.upsert({ threadId, userId: "user-42", status: "running" });
    await store.setPendingConfirmation(threadId, confirmation);

    const raw = redis.values.get(`threads:${threadId}`);
    expect(raw).toBeDefined();
    const storedThread = ThreadRecordSchema.parse(JSON.parse(raw ?? ""));
    expect(
      HumanConfirmationRecordSchema.parse(storedThread.pendingConfirmation)
    ).toEqual(confirmation);
    expect((await store.get(threadId))?.pendingConfirmation).toEqual(
      confirmation
    );
  });
});
