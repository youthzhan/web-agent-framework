import pino from "pino";
import type { AppEnv } from "../config/env.js";

export function createLogger(env: AppEnv) {
  return pino({
    level: env.LOG_LEVEL,
    base: {
      service: "web-agent-framework",
      env: env.NODE_ENV
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
