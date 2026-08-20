import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HumanConfirmationRecordSchema } from "../schemas/human-confirmation.js";

const BaseEventSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  requestId: z.string(),
  threadId: z.string().uuid(),
  userId: z.string(),
  ts: z.string().datetime(),
  data: z.unknown()
});

export const SseEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("token"),
    data: z.object({ content: z.string() })
  }),
  BaseEventSchema.extend({
    type: z.literal("tool_call"),
    data: z.object({
      toolName: z.string(),
      toolCallId: z.string(),
      mode: z.enum(["serial", "parallel"]).optional(),
      risk: z.enum(["low", "medium", "high"]),
      requiresConfirmation: z.boolean(),
      args: z.unknown()
    })
  }),
  BaseEventSchema.extend({
    type: z.literal("tool_result"),
    data: z.object({
      toolName: z.string(),
      toolCallId: z.string(),
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().optional()
    })
  }),
  BaseEventSchema.extend({
    type: z.literal("state_update"),
    data: z.object({
      status: z.string(),
      node: z.string().optional(),
      detail: z.unknown().optional()
    })
  }),
  BaseEventSchema.extend({
    type: z.literal("need_human_confirm"),
    data: HumanConfirmationRecordSchema
  }),
  BaseEventSchema.extend({
    type: z.literal("error"),
    data: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional()
    })
  }),
  BaseEventSchema.extend({
    type: z.literal("done"),
    data: z.object({
      status: z.enum(["completed", "waiting_human_confirm", "failed"]),
      output: z.string().optional()
    })
  })
]);

export type SseEvent = z.infer<typeof SseEventSchema>;
export type SseEventType = SseEvent["type"];

type EventInput<TType extends SseEventType> = Omit<
  Extract<SseEvent, { type: TType }>,
  "id" | "type" | "ts"
>;

export function createSseEvent<TType extends SseEventType>(
  type: TType,
  input: EventInput<TType>
): Extract<SseEvent, { type: TType }> {
  return SseEventSchema.parse({
    ...input,
    id: randomUUID(),
    type,
    ts: new Date().toISOString()
  }) as Extract<SseEvent, { type: TType }>;
}

export function formatSse(event: SseEvent): string {
  const serialized = JSON.stringify(event);
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${serialized}\n\n`;
}
