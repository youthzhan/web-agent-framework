import { AppError } from "./errors.js";

export async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  errorMessage: string,
  errorCode: "MODEL_TIMEOUT" | "GRAPH_TIMEOUT" | "TOOL_ERROR" = "TOOL_ERROR"
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await promiseFactory(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(errorCode, errorMessage, {
        statusCode: 504,
        cause: error
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
