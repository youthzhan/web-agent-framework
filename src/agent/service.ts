import { randomUUID } from "node:crypto";
import { AppError, normalizeError } from "../common/errors.js";
import { AsyncEventQueue } from "../common/async-event-queue.js";
import { createSseEvent, type SseEvent } from "../common/sse.js";
import { withRuntimeContext } from "../common/run-context.js";
import { withTimeout } from "../common/timeout.js";
import type { AppEnv } from "../config/env.js";
import type { AppLogger } from "../common/logger.js";
import type { MessageStore } from "../persistence/message-store.js";
import type { ThreadStore } from "../persistence/thread-store.js";
import type { ChatRequest, HumanConfirmation } from "../schemas/api.js";
import { AgentGraphInputSchema } from "./state.js";
import { AgentWorkflow } from "./workflow.js";

export class AgentService {
  constructor(
    private readonly env: AppEnv,
    private readonly logger: AppLogger,
    private readonly workflow: AgentWorkflow,
    private readonly messageStore: MessageStore,
    private readonly threadStore: ThreadStore
  ) {}

  runChat(
    requestId: string,
    request: ChatRequest
  ): { threadId: string; events: AsyncIterable<SseEvent> } {
    const threadId = request.threadId ?? randomUUID();
    const queue = new AsyncEventQueue<SseEvent>();

    void this.startGraphRun(queue, {
      requestId,
      threadId,
      userId: request.userId,
      mode: "new",
      request
    });

    return { threadId, events: queue };
  }

  runConfirmation(
    requestId: string,
    request: HumanConfirmation
  ): { threadId: string; events: AsyncIterable<SseEvent> } {
    const queue = new AsyncEventQueue<SseEvent>();
    void this.startGraphRun(queue, {
      requestId,
      threadId: request.threadId,
      userId: request.userId,
      mode: "resume",
      request
    });
    return { threadId: request.threadId, events: queue };
  }

  private async startGraphRun(
    queue: AsyncEventQueue<SseEvent>,
    input:
      | {
          mode: "new";
          requestId: string;
          threadId: string;
          userId: string;
          request: ChatRequest;
        }
      | {
          mode: "resume";
          requestId: string;
          threadId: string;
          userId: string;
          request: HumanConfirmation;
        }
  ): Promise<void> {
    const logger = this.logger.child({
      requestId: input.requestId,
      threadId: input.threadId,
      userId: input.userId
    });

    await withRuntimeContext(
      {
        requestId: input.requestId,
        threadId: input.threadId,
        userId: input.userId,
        logger,
        events: queue
      },
      async () => {
        try {
          queue.push(
            createSseEvent("state_update", {
              requestId: input.requestId,
              threadId: input.threadId,
              userId: input.userId,
              data: {
                status: "accepted",
                detail: { mode: input.mode }
              }
            })
          );

          const stream = await withTimeout(
            async () => {
              if (input.mode === "new") {
                await this.threadStore.upsert({
                  threadId: input.threadId,
                  userId: input.userId,
                  status: "running",
                  ...(input.request.metadata
                    ? { metadata: input.request.metadata }
                    : {})
                });
                await this.messageStore.append({
                  threadId: input.threadId,
                  userId: input.userId,
                  role: "user",
                  content: input.request.message,
                  metadata: input.request.metadata
                });
                const history = await this.messageStore.getRecent(
                  input.threadId,
                  this.env.HISTORY_WINDOW_MESSAGES
                );
                return await this.workflow.streamNew(
                  AgentGraphInputSchema.parse({
                    requestId: input.requestId,
                    threadId: input.threadId,
                    userId: input.userId,
                    message: input.request.message,
                    history,
                    modelProvider:
                      input.request.modelProvider ??
                      this.env.DEFAULT_MODEL_PROVIDER,
                    model: input.request.model
                  })
                );
              }

              const thread = await this.threadStore.get(input.threadId);
              if (!thread?.pendingConfirmation) {
                throw new AppError(
                  "BAD_REQUEST",
                  "Thread is not waiting for human confirmation",
                  { statusCode: 409 }
                );
              }
              if (
                thread.pendingConfirmation.confirmationId !==
                input.request.confirmationId
              ) {
                throw new AppError("BAD_REQUEST", "Confirmation id mismatch", {
                  statusCode: 409
                });
              }
              return await this.workflow.streamResume(input.threadId, {
                confirmationId: input.request.confirmationId,
                approved: input.request.approved,
                reason: input.request.reason,
                argsOverride: input.request.argsOverride
              });
            },
            this.env.AGENT_TIMEOUT_MS,
            "Agent task timed out",
            "GRAPH_TIMEOUT"
          );

          let waiting = false;
          let failed = false;
          for await (const chunk of stream) {
            if (this.workflow.isInterruptChunk(chunk)) {
              waiting = true;
            }
            if (this.workflow.isFailureChunk(chunk)) {
              failed = true;
            }
          }

          if (waiting) {
            await this.threadStore.setStatus(
              input.threadId,
              "waiting_human_confirm"
            );
            queue.push(
              createSseEvent("done", {
                requestId: input.requestId,
                threadId: input.threadId,
                userId: input.userId,
                data: { status: "waiting_human_confirm" }
              })
            );
          } else if (failed) {
            await this.threadStore.setStatus(input.threadId, "failed");
            queue.push(
              createSseEvent("done", {
                requestId: input.requestId,
                threadId: input.threadId,
                userId: input.userId,
                data: { status: "failed" }
              })
            );
          } else {
            await this.threadStore.setStatus(input.threadId, "completed");
            queue.push(
              createSseEvent("done", {
                requestId: input.requestId,
                threadId: input.threadId,
                userId: input.userId,
                data: { status: "completed" }
              })
            );
          }
        } catch (error) {
          const normalized = normalizeError(error);
          await this.threadStore
            .setStatus(input.threadId, "failed")
            .catch((statusError) => {
              logger.warn({ error: statusError }, "thread_status_update_failed");
            });
          logger.error({ error: normalized }, "agent_run_failed");
          queue.push(
            createSseEvent("error", {
              requestId: input.requestId,
              threadId: input.threadId,
              userId: input.userId,
              data: {
                code: normalized.code,
                message: normalized.message,
                details: normalized.details
              }
            })
          );
          queue.push(
            createSseEvent("done", {
              requestId: input.requestId,
              threadId: input.threadId,
              userId: input.userId,
              data: { status: "failed" }
            })
          );
        } finally {
          queue.close();
        }
      }
    );
  }
}
