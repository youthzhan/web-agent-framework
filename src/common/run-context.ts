import { AsyncLocalStorage } from "node:async_hooks";
import type { AppLogger } from "./logger.js";
import { createSseEvent, type SseEvent, type SseEventType } from "./sse.js";

export type RuntimeContext = {
  requestId: string;
  threadId: string;
  userId: string;
  logger: AppLogger;
  events: {
    push(event: SseEvent): void;
  };
};

const storage = new AsyncLocalStorage<RuntimeContext>();

export async function withRuntimeContext<T>(
  context: RuntimeContext,
  fn: () => Promise<T>
): Promise<T> {
  return await storage.run(context, fn);
}

export function getRuntimeContext(): RuntimeContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("Runtime context is not available");
  }
  return context;
}

export function tryRuntimeContext(): RuntimeContext | undefined {
  return storage.getStore();
}

export function emitSseEvent<TType extends SseEventType>(
  type: TType,
  input: Omit<Extract<SseEvent, { type: TType }>, "id" | "type" | "ts">
): void {
  const context = getRuntimeContext();
  context.events.push(createSseEvent(type, input));
}
