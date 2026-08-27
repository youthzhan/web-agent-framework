import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AppError } from "../common/errors.js";
import type { AppEnv } from "../config/env.js";
import type { AppLogger } from "../common/logger.js";
import type { AgentTool } from "./types.js";
import type { ToolRegistry } from "./types.js";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
};

type RuntimeTool = {
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
  inputSchema?: JsonSchema;
  execute(
    args: Record<string, unknown>,
    context?: { signal?: AbortSignal }
  ): Promise<unknown>;
};

type RuntimeFactory = (options?: Record<string, unknown>) => {
  listTools(): RuntimeTool[];
};

type RuntimeManifest = {
  module?: string;
  factory?: string;
};

type SkillPackManifest = {
  runtime?: RuntimeManifest;
};

type RuntimeDescriptor = {
  manifestPath: string;
  manifest: RuntimeManifest;
};

/**
 * Discovers runtime declarations next to Skill roots and registers their
 * tools through the host's generic ToolRegistry. A Skill package owns the
 * runtime implementation; the Agent only supplies configuration and policy.
 */
export async function registerSkillRuntimeTools(
  skillsRoots: readonly string[],
  env: AppEnv,
  registry: ToolRegistry,
  logger: AppLogger
): Promise<string[]> {
  const descriptors = await discoverRuntimeDescriptors(skillsRoots);
  const registered: string[] = [];
  const loadedModules = new Set<string>();

  for (const descriptor of descriptors) {
    const modulePath = path.resolve(
      path.dirname(descriptor.manifestPath),
      descriptor.manifest.module ?? ""
    );
    if (!descriptor.manifest.module || loadedModules.has(modulePath)) {
      continue;
    }
    loadedModules.add(modulePath);

    const imported = await import(pathToFileURL(modulePath).href);
    const factoryName = descriptor.manifest.factory;
    const factory = factoryName
      ? imported[factoryName]
      : imported.default;
    if (typeof factory !== "function") {
      throw new AppError(
        "TOOL_ERROR",
        `Skill runtime factory not found: ${factoryName ?? "default"}`,
        { statusCode: 500, details: { modulePath } }
      );
    }

    const runtime = (factory as RuntimeFactory)({
      config: env as unknown as Record<string, unknown>,
      useProcessEnv: false
    });
    const tools = runtime.listTools();
    for (const runtimeTool of tools) {
      registry.register(adaptRuntimeTool(runtimeTool));
      registered.push(runtimeTool.name);
    }
    logger.info(
      { modulePath, tools: tools.map((tool) => tool.name) },
      "skill_runtime_loaded"
    );
  }

  return registered;
}

async function discoverRuntimeDescriptors(
  skillsRoots: readonly string[]
): Promise<RuntimeDescriptor[]> {
  const descriptors: RuntimeDescriptor[] = [];
  const seen = new Set<string>();

  for (const root of skillsRoots) {
    const candidates = [
      path.join(root, "skill-pack.json"),
      path.join(path.dirname(root), "skill-pack.json")
    ];
    candidates.push(...(await findNestedManifests(root)));
    for (const candidate of candidates) {
      const descriptor = await readRuntimeDescriptor(candidate);
      if (!descriptor || seen.has(descriptor.manifestPath)) {
        continue;
      }
      seen.add(descriptor.manifestPath);
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

async function findNestedManifests(root: string): Promise<string[]> {
  const manifests: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "skill-pack.json") {
        manifests.push(entryPath);
      } else if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(root);
  return manifests;
}

async function readRuntimeDescriptor(
  manifestPath: string
): Promise<RuntimeDescriptor | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as SkillPackManifest;
    if (!parsed.runtime?.module) {
      return undefined;
    }
    return {
      manifestPath,
      manifest: parsed.runtime
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function adaptRuntimeTool(runtimeTool: RuntimeTool): AgentTool {
  return {
    name: runtimeTool.name,
    description: runtimeTool.description,
    argsSchema: jsonSchemaToZod(runtimeTool.inputSchema ?? {
      type: "object",
      additionalProperties: true
    }),
    risk: runtimeTool.risk,
    execute: async (args, context) => {
      try {
        return await runtimeTool.execute(
          args as Record<string, unknown>,
          context.signal ? { signal: context.signal } : {}
        );
      } catch (error) {
        throw mapRuntimeError(error);
      }
    }
  };
}

function mapRuntimeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : "Skill runtime execution failed";
  if (code === "INVALID_ARGUMENT") {
    return new AppError("BAD_REQUEST", message, {
      statusCode: 400,
      details: candidate.details,
      cause: error
    });
  }
  if (code === "SECURITY_VIOLATION") {
    return new AppError("SECURITY_VIOLATION", message, {
      statusCode: 403,
      details: candidate.details,
      cause: error
    });
  }
  return new AppError("TOOL_ERROR", message, {
    details: candidate.details,
    cause: error
  });
}

function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  let result: z.ZodTypeAny;
  if (schema.enum && schema.enum.length > 0 && schema.enum.every((item) => typeof item === "string")) {
    result = z.enum(schema.enum as [string, ...string[]]);
  } else if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, property] of Object.entries(schema.properties)) {
      let value = jsonSchemaToZod(property);
      if (property.default !== undefined) {
        value = value.default(property.default);
      } else if (!required.has(name)) {
        value = value.optional();
      }
      shape[name] = value;
    }
    result = z.object(shape);
  } else if (
    schema.type === "object" &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    result = z.record(z.string(), jsonSchemaToZod(schema.additionalProperties));
  } else if (schema.type === "array") {
    result = z.array(schema.items ? jsonSchemaToZod(schema.items) : z.any());
  } else if (schema.type === "string") {
    result = z.string();
  } else if (schema.type === "number" || schema.type === "integer") {
    result = z.number();
  } else if (schema.type === "boolean") {
    result = z.boolean();
  } else {
    result = z.any();
  }
  return result;
}
