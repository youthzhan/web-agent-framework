import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { ModelProviderSchema } from "../schemas/api.js";

const emptyToUndefined = (value: unknown) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
};

const BooleanEnvSchema = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const DisabledBooleanEnvSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1).max(100),
  provider: ModelProviderSchema,
  model: z.string().min(1).max(128)
});

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

const ModelCatalogSchema = z.array(ModelCatalogEntrySchema).min(1).max(20);

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
  // Responses API state is intentionally opt-in. Each enabled provider stores
  // final responses and later turns use `previous_response_id`.
  OPENAI_RESPONSES_STATE_ENABLED: DisabledBooleanEnvSchema,
  OPENAI_RESPONSES_STORE: DisabledBooleanEnvSchema,
  OPENAI_COMPATIBLE_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  OPENAI_COMPATIBLE_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:8000/v1"),
  OPENAI_COMPATIBLE_MODEL: z.string().default("local-model"),
  OPENAI_COMPATIBLE_RESPONSES_STATE_ENABLED: DisabledBooleanEnvSchema,
  OPENAI_COMPATIBLE_RESPONSES_STORE: DisabledBooleanEnvSchema,
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: z.string().default("claude-3-5-sonnet-latest"),
  MODEL_CATALOG: z.preprocess(emptyToUndefined, z.string().optional()),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PLANNER_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  SKILL_PLAN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SKILL_SUMMARY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
  // The final Agent node already summarizes tool results. Keep this optional
  // intermediate model call disabled by default to reduce Skill latency.
  SKILL_SUMMARY_ENABLED: DisabledBooleanEnvSchema,
  // For explicit file paths and HTTP URLs, derive a schema-validated tool
  // plan locally instead of spending an extra model request on planning.
  SKILL_DETERMINISTIC_TOOL_PLAN_ENABLED: BooleanEnvSchema,
  SKILL_SEMANTIC_RECALL_ENABLED: BooleanEnvSchema,
  SKILL_SEMANTIC_RECALL_LIMIT: z.coerce.number().int().min(1).max(5).default(3),
  SKILL_PLANNER_FALLBACK_ENABLED: BooleanEnvSchema,
  SKILL_TOOL_PLAN_FALLBACK_ENABLED: BooleanEnvSchema,
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Final-answer prompt/output budgets keep tool-heavy requests responsive.
  FINAL_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(20).default(4),
  FINAL_TOOL_RESULT_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(100_000)
    .default(12_000),
  FINAL_RESPONSE_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(64)
    .max(4_096)
    .default(512),
  // Direct chat has no tool evidence to synthesize. Tighter budgets reduce
  // provider prefill and completion latency while full history stays in Redis.
  DIRECT_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(10).default(2),
  DIRECT_HISTORY_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(500)
    .max(20_000)
    .default(4_000),
  DIRECT_MEMORY_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(1_500),
  DIRECT_RESPONSE_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(64)
    .max(1_024)
    .default(768),

  AGENT_RECURSION_LIMIT: z.coerce.number().int().min(3).max(100).default(25),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  HISTORY_WINDOW_MESSAGES: z.coerce.number().int().min(2).max(50).default(16),
  MEMORY_SUMMARY_ENABLED: BooleanEnvSchema,
  MEMORY_SUMMARY_TRIGGER_MESSAGES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(8),
  MEMORY_SUMMARY_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(500)
    .max(20_000)
    .default(6_000),
  MEMORY_SUMMARY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(20_000),

  SANDBOX_ROOT: z.string().default("./sandbox"),
  MAX_FILE_READ_BYTES: z.coerce.number().int().positive().default(262_144),
  HTTP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HTTP_TOOL_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524_288),
  HTTP_TOOL_ALLOWED_HOSTS: z.string().default("*"),

  // M4 tools never accept an arbitrary URL from the model. They resolve
  // relative /api paths against this configured origin and add these
  // server-side credentials.
  M4_BASE_URL: z.string().url().default("http://localhost:5800"),
  M4_DEFAULT_SCENE_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
  M4_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  M4_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524_288),
  M4_AUTH_MODE: z.enum(["header", "cookie"]).default("header"),
  M4_USER_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  M4_USER_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  // M4's user-session headers are derived from its cookie names. They are
  // intentionally configurable for deployments using a gateway adapter.
  M4_USER_ID_HEADER: z.string().default("x-xzz-qyq"),
  M4_USER_TOKEN_HEADER: z.string().default("x-xzz-qyx"),
  M4_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  M4_APP_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  M4_COOKIE: z.preprocess(emptyToUndefined, z.string().optional()),
  M4_USERNAME: z.preprocess(emptyToUndefined, z.string().optional()),
  M4_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),

  // The independent M4 Skill pack is installed as an npm dependency. Keep
  // the built-in skills root first so local skills can override by name.
  SKILLS_DIR: z.string().default("./skills;./node_modules/m4-skills/skills"),
  // Optional additional roots. On Windows use `;` between directories; on
  // POSIX use `:`. Commas are accepted on both platforms for .env files.
  SKILLS_DIRS: z.preprocess(emptyToUndefined, z.string().optional())
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  checkpointBackend: "redis" | "memory";
  sandboxRootAbs: string;
  skillsDirAbs: string;
  skillsDirsAbs: string[];
  httpAllowedHosts: string[];
  modelCatalog: ModelCatalogEntry[];
};

function splitSkillDirectories(value: string): string[] {
  const separator = process.platform === "win32" ? /[;,]/ : /[:,;]/;
  return value
    .split(separator)
    .map((directory) => directory.trim())
    .filter(Boolean);
}

export function loadEnv(): AppEnv {
  const parsed = EnvSchema.parse(process.env);
  if (
    parsed.OPENAI_RESPONSES_STATE_ENABLED &&
    !parsed.OPENAI_RESPONSES_STORE
  ) {
    throw new Error(
      "OPENAI_RESPONSES_STORE=true is required when OPENAI_RESPONSES_STATE_ENABLED=true"
    );
  }
  if (
    parsed.OPENAI_COMPATIBLE_RESPONSES_STATE_ENABLED &&
    !parsed.OPENAI_COMPATIBLE_RESPONSES_STORE
  ) {
    throw new Error(
      "OPENAI_COMPATIBLE_RESPONSES_STORE=true is required when OPENAI_COMPATIBLE_RESPONSES_STATE_ENABLED=true"
    );
  }
  const checkpointBackend =
    parsed.CHECKPOINT_BACKEND ??
    (parsed.NODE_ENV === "development" ? "memory" : "redis");
  if (parsed.NODE_ENV === "production" && checkpointBackend === "memory") {
    throw new Error(
      "CHECKPOINT_BACKEND=memory is only allowed when NODE_ENV is development or test"
    );
  }
  const defaultModel = ModelCatalogEntrySchema.parse({
    id: "default",
    label: "\u670d\u52a1\u7aef\u9ed8\u8ba4\u6a21\u578b",
    provider: parsed.DEFAULT_MODEL_PROVIDER,
    model: resolveDefaultModelName(parsed)
  });
  const skillDirectories = splitSkillDirectories(
    parsed.SKILLS_DIRS ?? parsed.SKILLS_DIR
  );
  return {
    ...parsed,
    checkpointBackend,
    sandboxRootAbs: path.resolve(process.cwd(), parsed.SANDBOX_ROOT),
    skillsDirAbs: path.resolve(process.cwd(), skillDirectories[0] ?? parsed.SKILLS_DIR),
    skillsDirsAbs: skillDirectories.map((directory) =>
      path.resolve(process.cwd(), directory)
    ),
    httpAllowedHosts: parsed.HTTP_TOOL_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    modelCatalog: parseModelCatalog(parsed.MODEL_CATALOG, defaultModel)
  };
}

/** Parses an allow-listed model catalog without ever exposing provider keys. */
export function parseModelCatalog(
  value: string | undefined,
  defaultModel: ModelCatalogEntry
): ModelCatalogEntry[] {
  if (!value) {
    return [defaultModel];
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new Error(`MODEL_CATALOG must be valid JSON: ${(error as Error).message}`);
  }
  const configured = ModelCatalogSchema.parse(decoded);
  const configuredDefault = configured.find(
    (entry) =>
      entry.provider === defaultModel.provider && entry.model === defaultModel.model
  );
  const seen = new Set<string>();
  return [configuredDefault ?? defaultModel, ...configured].filter((entry) => {
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveDefaultModelName(parsed: z.infer<typeof EnvSchema>): string {
  switch (parsed.DEFAULT_MODEL_PROVIDER) {
    case "anthropic":
      return parsed.ANTHROPIC_MODEL;
    case "openai":
      return parsed.OPENAI_MODEL;
    case "openai-compatible":
      return parsed.OPENAI_COMPATIBLE_MODEL;
  }
}
