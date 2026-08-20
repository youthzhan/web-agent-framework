import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "MODEL_ERROR",
  "MODEL_TIMEOUT",
  "TOOL_ERROR",
  "SECURITY_VIOLATION",
  "HUMAN_REJECTED",
  "GRAPH_INTERRUPTED",
  "GRAPH_TIMEOUT",
  "PERSISTENCE_ERROR",
  "UNKNOWN"
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;
  public readonly statusCode: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: { statusCode?: number; details?: unknown; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
    this.statusCode = options.statusCode ?? 500;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new AppError("BAD_REQUEST", "Validation failed", {
      statusCode: 400,
      details: error.issues,
      cause: error
    });
  }
  if (error instanceof Error) {
    return new AppError("UNKNOWN", error.message, { cause: error });
  }
  return new AppError("UNKNOWN", "Unknown error", { details: error });
}
