import { z } from "zod";
import { AppError } from "../common/errors.js";
import { withTimeout } from "../common/timeout.js";
import type { AppEnv } from "../config/env.js";
import type { AgentTool } from "./types.js";

const HttpRequestArgsSchema = z.object({
  url: z.string().url().max(4_000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().max(100_000).optional()
});

function hostAllowed(hostname: string, allowList: string[]): boolean {
  return (
    allowList.includes("*") ||
    allowList.some((allowed) => {
      if (allowed.startsWith("*.")) {
        return hostname === allowed.slice(2) || hostname.endsWith(allowed.slice(1));
      }
      return hostname === allowed;
    })
  );
}

export function createHttpRequestTool(
  env: AppEnv
): AgentTool<typeof HttpRequestArgsSchema> {
  return {
    name: "http_request",
    description:
      "Call an allow-listed external HTTP endpoint and return a bounded text response.",
    argsSchema: HttpRequestArgsSchema,
    // External side effects require a user decision before execution.
    risk: "high",
    async execute(args, context) {
      const parsedUrl = new URL(args.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new AppError("SECURITY_VIOLATION", "Only HTTP(S) URLs are allowed", {
          statusCode: 403
        });
      }
      if (!hostAllowed(parsedUrl.hostname, env.httpAllowedHosts)) {
        throw new AppError("SECURITY_VIOLATION", "HTTP host is not allow-listed", {
          statusCode: 403,
          details: { hostname: parsedUrl.hostname }
        });
      }

      const requestInit: RequestInit = {
        method: args.method,
        headers: args.headers
      };
      if (
        args.method !== "GET" &&
        args.method !== "DELETE" &&
        args.body !== undefined
      ) {
        requestInit.body = args.body;
      }

      const response = await withTimeout(
        (signal) =>
          fetch(parsedUrl, {
            ...requestInit,
            signal: context.signal ?? signal
          }),
        env.HTTP_TOOL_TIMEOUT_MS,
        "HTTP tool request timed out"
      );

      const text = await response.text();
      const boundedText = text.slice(0, env.HTTP_TOOL_MAX_RESPONSE_BYTES);
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: boundedText,
        truncated: text.length > boundedText.length
      };
    }
  };
}
