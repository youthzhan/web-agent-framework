import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { emitSseEvent, getRuntimeContext } from "../common/run-context.js";
import type { AppLogger } from "../common/logger.js";
import type { AppEnv } from "../config/env.js";
import type { ModelRouter } from "../model/model-router.js";
import type { ModelSelection } from "../model/types.js";
import type { MessageRecord } from "../persistence/message-store.js";
import { MessageStore } from "../persistence/message-store.js";
import {
  ConversationMemoryStore,
  type ConversationMemoryRecord
} from "./conversation-memory-store.js";

export type ConversationContext = {
  history: MessageRecord[];
  longTermMemory: string;
};

/**
 * Keeps full messages in MessageStore while periodically compacting older
 * messages into one durable summary. A failed compaction never blocks chat:
 * the still-unsummarized messages remain in the short-term context instead.
 */
export class ConversationMemoryService {
  constructor(
    private readonly env: AppEnv,
    private readonly logger: AppLogger,
    private readonly messages: MessageStore,
    private readonly memoryStore: ConversationMemoryStore,
    private readonly modelRouter: ModelRouter
  ) {}

  async buildContext(input: {
    threadId: string;
    userId: string;
    selection: ModelSelection;
  }): Promise<ConversationContext> {
    const totalMessages = await this.messages.count(input.threadId);
    const recentStart = Math.max(
      0,
      totalMessages - this.env.HISTORY_WINDOW_MESSAGES
    );
    let memory = await this.memoryStore.get(input.threadId);
    const coveredCount = Math.min(
      memory?.coveredMessageCount ?? 0,
      recentStart
    );
    const unsummarizedCount = recentStart - coveredCount;

    if (
      this.env.MEMORY_SUMMARY_ENABLED &&
      unsummarizedCount >= this.env.MEMORY_SUMMARY_TRIGGER_MESSAGES
    ) {
      memory = await this.compactOlderMessages({
        ...input,
        memory,
        fromOffset: coveredCount,
        untilOffset: recentStart
      });
    }

    // Do not discard old messages if a summary has not been made yet. This
    // makes compaction failure degrade to a larger temporary prompt, not loss
    // of conversational facts.
    const historyStart = memory?.coveredMessageCount ?? 0;
    const history = await this.messages.getRange(
      input.threadId,
      historyStart,
      -1
    );
    return {
      history,
      longTermMemory: memory?.summary ?? ""
    };
  }

  private async compactOlderMessages(input: {
    threadId: string;
    userId: string;
    selection: ModelSelection;
    memory: ConversationMemoryRecord | undefined;
    fromOffset: number;
    untilOffset: number;
  }): Promise<ConversationMemoryRecord | undefined> {
    const messages = await this.messages.getRange(
      input.threadId,
      input.fromOffset,
      input.untilOffset - 1
    );
    if (messages.length === 0) {
      return input.memory;
    }

    const context = getRuntimeContext();
    emitSseEvent("state_update", {
      requestId: context.requestId,
      threadId: context.threadId,
      userId: context.userId,
      data: {
        status: "memory_compacting",
        node: "conversation_memory",
        detail: { messageCount: messages.length }
      }
    });

    try {
      const model = this.modelRouter.create(input.selection);
      const response = await model.invokeText(
        [
          new SystemMessage(
            [
              "You maintain durable memory for an AI agent conversation.",
              "Merge the existing summary with the older conversation messages.",
              "Preserve user preferences, identity facts, goals, constraints,",
              "decisions, completed work, unresolved tasks, and factual results.",
              "Discard greetings and repetition. Do not invent facts.",
              "Write a concise structured summary in the user's language."
            ].join(" ")
          ),
          new HumanMessage(
            JSON.stringify({
              existingSummary: input.memory?.summary ?? "",
              messages: messages.map((message) => ({
                role: message.role,
                content: message.content
              }))
            })
          )
        ],
        {
          operation: "conversation_memory_compact",
          timeoutMs: this.env.MEMORY_SUMMARY_TIMEOUT_MS
        }
      );
      const summary = response.text.trim().slice(0, this.env.MEMORY_SUMMARY_MAX_CHARS);
      if (!summary) {
        throw new Error("Memory summarizer returned empty content");
      }
      const memory = await this.memoryStore.save({
        threadId: input.threadId,
        userId: input.userId,
        summary,
        coveredMessageCount: input.untilOffset
      });
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "memory_compacted",
          node: "conversation_memory",
          detail: {
            coveredMessageCount: memory.coveredMessageCount,
            summaryChars: memory.summary.length
          }
        }
      });
      this.logger.info(
        {
          threadId: input.threadId,
          userId: input.userId,
          coveredMessageCount: memory.coveredMessageCount,
          summaryChars: memory.summary.length
        },
        "conversation_memory_compacted"
      );
      return memory;
    } catch (error) {
      this.logger.warn(
        {
          threadId: input.threadId,
          userId: input.userId,
          error
        },
        "conversation_memory_compaction_failed"
      );
      emitSseEvent("state_update", {
        requestId: context.requestId,
        threadId: context.threadId,
        userId: context.userId,
        data: {
          status: "memory_compaction_failed",
          node: "conversation_memory"
        }
      });
      return input.memory;
    }
  }
}
