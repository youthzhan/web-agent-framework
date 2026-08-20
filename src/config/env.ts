import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const emptyToUndefined = (value: unknown) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
};

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  AUTH_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  REDIS_KEY_PREFIX: z.string().default("agent:"),
  CHECKPOINT_BACKEND: z.enum(["redis", "memory"]).optional(),
  CHECKPOINT_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  MESSAGE_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),

  DEFAULT_MODEL_PROVIDER: z
    .enum(["openai", "openai-compatible", "anthropic"])
    .default("openai"),
  OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_COMPATIBLE_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  OPENAI_COMPATIBLE_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:8000/v1"),
  OPENAI_COMPATIBLE_MODEL: z.string().default("local-model"),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: z.string().default("claude-3-5-sonnet-latest"),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  AGENT_RECURSION_LIMIT: z.coerce.number().int().min(3).max(100).default(25),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  HISTORY_WINDOW_MESSAGES: z.coerce.number().int().min(2).max(50).default(16),

  SANDBOX_ROOT: z.string().default("./sandbox"),
  MAX_FILE_READ_BYTES: z.coerce.number().int().positive().default(262_144),
  HTTP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HTTP_TOOL_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524_288),
  HTTP_TOOL_ALLOWED_HOSTS: z.string().default("*"),

  SKILLS_DIR: z.string().default("./skills")
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  checkpointBackend: "redis" | "memory";
  sandboxRootAbs: string;
  skillsDirAbs: string;
  httpAllowedHosts: string[];
};

export function loadEnv(): AppEnv {
  const parsed = EnvSchema.parse(process.env);
  const checkpointBackend =
    parsed.CHECKPOINT_BACKEND ??
    (parsed.NODE_ENV === "development" ? "memory" : "redis");
  if (parsed.NODE_ENV === "production" && checkpointBackend === "memory") {
    throw new Error(
      "CHECKPOINT_BACKEND=memory is only allowed when NODE_ENV is development or test"
    );
  }
  return {
    ...parsed,
    checkpointBackend,
    sandboxRootAbs: path.resolve(process.cwd(), parsed.SANDBOX_ROOT),
    skillsDirAbs: path.resolve(process.cwd(), parsed.SKILLS_DIR),
    httpAllowedHosts: parsed.HTTP_TOOL_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim())
      .filter(Boolean)
  };
}
