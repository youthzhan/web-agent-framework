import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesRequest,
  describeModelProviderError
} from "../src/model/model-adapter.js";
import { ThreadStore } from "../src/persistence/thread-store.js";

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

describe("OpenAI Responses API state request", () => {
  it("sets store and resumes from the persisted response id", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-4.1-mini",
      messages: [
        new SystemMessage("Use concise Markdown."),
        new HumanMessage("Continue the existing conversation.")
      ],
      previousResponseId: "resp_previous_123",
      store: true
    });

    expect(request).toMatchObject({
      model: "gpt-4.1-mini",
      input: "Continue the existing conversation.",
      instructions: "Use concise Markdown.",
      previous_response_id: "resp_previous_123",
      store: true,
      stream: true
    });
  });

  it("keeps the vendor response id with the Redis-backed thread state", async () => {
    const store = new ThreadStore(
      new MemoryRedis() as never,
      { MESSAGE_TTL_SECONDS: 3_600 } as never
    );
    const threadId = "6f0e9e73-4fd8-48e3-a2b0-954cdb30f7fe";
    await store.upsert({ threadId, userId: "user-42", status: "running" });
    await store.setOpenAiResponseState(threadId, {
      responseId: "resp_123",
      provider: "openai-compatible",
      model: "gpt-4.1-mini"
    });

    expect((await store.get(threadId))?.openAiResponseState).toMatchObject({
      responseId: "resp_123",
      provider: "openai-compatible",
      model: "gpt-4.1-mini"
    });
  });

  it("preserves provider diagnostics without exposing API keys", () => {
    const error = Object.assign(
      new Error("invalid model using Bearer ark-secret-token"),
      { status: 400, code: "InvalidParameter", request_id: "req_123" }
    );
    const described = describeModelProviderError(error);

    expect(described.message).toContain("httpStatus=400");
    expect(described.message).toContain("providerCode=InvalidParameter");
    expect(described.message).not.toContain("ark-secret-token");
    expect(described.details).toMatchObject({ providerRequestId: "req_123" });
  });
});
