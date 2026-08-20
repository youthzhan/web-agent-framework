import { describe, expect, it } from "vitest";
import { withRuntimeContext } from "../src/common/run-context.js";
import { createLogger } from "../src/common/logger.js";
import { ConversationMemoryService } from "../src/memory/conversation-memory-service.js";
import { ConversationMemoryStore } from "../src/memory/conversation-memory-store.js";
import { ModelRouter } from "../src/model/model-router.js";
import { MemoryPersistenceStore } from "../src/persistence/memory.js";
import { MessageStore } from "../src/persistence/message-store.js";

describe("conversation memory", () => {
  it("compacts old messages and retains only the recent window as raw history", async () => {
    const threadId = "e0ceba44-7f8c-45c9-a555-cf8bd565a2e1";
    const userId = "memory-user";
    const env = {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MESSAGE_TTL_SECONDS: 3_600,
      HISTORY_WINDOW_MESSAGES: 2,
      MEMORY_SUMMARY_ENABLED: true,
      MEMORY_SUMMARY_TRIGGER_MESSAGES: 1,
      MEMORY_SUMMARY_MAX_CHARS: 6_000,
      MEMORY_SUMMARY_TIMEOUT_MS: 1_000
    } as never;
    const logger = createLogger(env);
    const persistence = new MemoryPersistenceStore();
    const messages = new MessageStore(persistence, env);
    const memoryStore = new ConversationMemoryStore(persistence, env);
    let summaryCalls = 0;
    const modelRouter = {
      create: () => ({
        invokeText: async () => {
          summaryCalls += 1;
          return { text: "用户偏好中文回答；当前任务仍在进行。" };
        }
      })
    } as unknown as ModelRouter;
    const service = new ConversationMemoryService(
      env,
      logger,
      messages,
      memoryStore,
      modelRouter
    );

    for (const [role, content] of [
      ["user", "我希望你使用中文。"],
      ["assistant", "好的，我会使用中文。"],
      ["user", "请记住当前任务。"],
      ["assistant", "我已记住当前任务。"]
    ] as const) {
      await messages.append({ threadId, userId, role, content });
    }

    const events: string[] = [];
    const context = await withRuntimeContext(
      {
        requestId: "memory-test-request",
        threadId,
        userId,
        logger,
        events: { push: (event) => events.push(event.type) }
      },
      async () =>
        await service.buildContext({
          threadId,
          userId,
          selection: { provider: "openai-compatible" }
        })
    );

    expect(summaryCalls).toBe(1);
    expect(context.longTermMemory).toContain("用户偏好中文回答");
    expect(context.history.map((message) => message.content)).toEqual([
      "请记住当前任务。",
      "我已记住当前任务。"
    ]);
    expect(events).toEqual(["state_update", "state_update"]);
    expect(await memoryStore.get(threadId)).toMatchObject({
      coveredMessageCount: 2,
      summary: "用户偏好中文回答；当前任务仍在进行。"
    });

    await withRuntimeContext(
      {
        requestId: "memory-test-repeat",
        threadId,
        userId,
        logger,
        events: { push: () => undefined }
      },
      async () =>
        await service.buildContext({
          threadId,
          userId,
          selection: { provider: "openai-compatible" }
        })
    );
    expect(summaryCalls).toBe(1);
  });
});
