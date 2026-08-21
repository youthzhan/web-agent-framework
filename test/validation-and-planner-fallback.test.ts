import { z } from "zod";
import { describe, expect, it } from "vitest";
import { isRecoverablePlannerError } from "../src/agent/workflow.js";
import { AppError, normalizeError } from "../src/common/errors.js";
import { ChatRequestSchema } from "../src/schemas/api.js";

describe("validation and planner fallback", () => {
  it("accepts ordinary repeated Chinese text as a chat message", () => {
    expect(
      ChatRequestSchema.parse({
        message: "产品技术流程与技术流程技术流程技术流",
        userId: "demo-user"
      }).message
    ).toBe("产品技术流程与技术流程技术流程技术流");
  });

  it.each(["MODEL_TIMEOUT", "MODEL_ERROR"] as const)(
    "allows safe planner fallback for %s",
    (code) => {
      expect(isRecoverablePlannerError(new AppError(code, "planner failed"))).toBe(
        true
      );
    }
  );

  it("does not hide the failing field in validation errors", () => {
    const schema = z.object({ threadId: z.string().uuid() });
    const parsed = schema.safeParse({ threadId: "not-a-uuid" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const error = normalizeError(parsed.error);
    expect(error.message).toContain("threadId");
    expect(error.details).toEqual(parsed.error.issues);
  });
});
