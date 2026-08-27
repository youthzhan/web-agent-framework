import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors.js";
import { createLogger } from "../src/common/logger.js";
import { withRuntimeContext } from "../src/common/run-context.js";
import type { ModelAdapter } from "../src/model/model-adapter.js";
import type { ThreadStore } from "../src/persistence/thread-store.js";
import { SkillEngine } from "../src/skills/skill-engine.js";
import { SkillLoader } from "../src/skills/skill-loader.js";
import {
  HumanConfirmationRequired,
  ToolExecutor
} from "../src/tools/executor.js";
import { InMemoryToolRegistry } from "../src/tools/registry.js";

describe("skill tool-plan fallback", () => {
  it("skips the model tool planner for an explicit sandbox file path", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const events: Array<{ type: string; data: unknown }> = [];
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger);
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "file_read",
      description: "test file reader",
      argsSchema: z.object({ path: z.string() }),
      risk: "low",
      execute: async () => ({})
    });
    const engine = new SkillEngine(
      { SKILL_DETERMINISTIC_TOOL_PLAN_ENABLED: true } as never,
      loader,
      registry,
      {} as ToolExecutor,
      {} as ThreadStore,
      logger
    );
    const model = {
      helperMessages: () => {
        throw new Error("The deterministic plan must not invoke the model");
      },
      invokeJson: async () => {
        throw new Error("The deterministic plan must not invoke the model");
      }
    } as unknown as ModelAdapter;

    const prepared = await withRuntimeContext(
      {
        requestId: "deterministic-plan-request",
        threadId: "81aeeccd-dae0-4ea4-9d48-932f02c8d17c",
        userId: "deterministic-plan-user",
        logger,
        events: { push: (event: { type: string; data: unknown }) => events.push(event) }
      },
      async () =>
        await engine.prepare(
          {
            skillName: "workspace-inspection",
            reason: "read file",
            mode: "serial",
            input: "读取 README.md"
          },
          model
        )
    );

    expect(prepared.toolPlan.calls).toMatchObject([
      { toolName: "file_read", args: { path: "README.md" } }
    ]);
    expect(events.some((event) => event.type === "state_update" && (event.data as { status?: string }).status === "skill_planning_deterministic")).toBe(true);
  });

  it.each(["MODEL_TIMEOUT", "MODEL_ERROR"] as const)(
    "retains verified tool results when Skill summary returns %s",
    async (errorCode) => {
      const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
      const events: Array<{ type: string; data: unknown }> = [];
      const engine = new SkillEngine(
        { SKILL_SUMMARY_TIMEOUT_MS: 1, SKILL_SUMMARY_ENABLED: true } as never,
        {} as SkillLoader,
        {} as InMemoryToolRegistry,
        {
          executeCalls: async () => [
            { call: {} as never, result: { path: "README.md", content: "ok" } }
          ]
        } as unknown as ToolExecutor,
        {} as ThreadStore,
        logger
      );
      const failedModel = {
        helperMessages: () => [],
        invokeText: async () => {
          throw new AppError(errorCode, "simulated summary failure");
        }
      } as unknown as ModelAdapter;

      const result = await withRuntimeContext(
        {
          requestId: "summary-fallback-request",
          threadId: "81aeeccd-dae0-4ea4-9d48-932f02c8d17c",
          userId: "summary-fallback-user",
          logger,
          events: { push: (event: { type: string; data: unknown }) => events.push(event) }
        },
        async () =>
          await engine.executePrepared(
            {
              skill: {
                name: "workspace-inspection",
                description: "test",
                directory: "skills/workspace-inspection",
                filePath: "skills/workspace-inspection/SKILL.md",
                allowedToolsList: ["file_read"],
                triggers: [],
                routingKeywords: [],
                routingExcludes: [],
                instructions: "Read the file."
              },
              input: "Read README.md",
              mode: "serial",
              reason: "test",
              toolPlan: { mode: "serial", calls: [{ toolName: "file_read", toolCallId: "readme", args: { path: "README.md" } }] },
              requiresConfirmation: false,
              confirmations: []
            },
            failedModel,
            { approvedHighRiskToolCallIds: [] }
          )
      );

      expect(result.output).toContain("intermediate model summary was unavailable");
      expect(result.toolResults).toEqual([{ path: "README.md", content: "ok" }]);
      expect(events.some((event) => event.type === "state_update" && (event.data as { status?: string }).status === "skill_summary_fallback")).toBe(true);
    }
  );

  it.each(["MODEL_TIMEOUT", "MODEL_ERROR"] as const)(
    "derives a validated sandbox file call after %s",
    async (errorCode) => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger);
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "file_read",
      description: "test file reader",
      argsSchema: z.object({ path: z.string() }),
      risk: "low",
      execute: async () => ({})
    });
    const engine = new SkillEngine(
      {
        SKILL_PLAN_TIMEOUT_MS: 1,
        SKILL_TOOL_PLAN_FALLBACK_ENABLED: true
      } as never,
      loader,
      registry,
      {} as ToolExecutor,
      {} as ThreadStore,
      logger
    );
    const failedModel = {
      helperMessages: () => [],
      invokeJson: async () => {
        throw new AppError(errorCode, "simulated skill planner failure");
      }
    } as unknown as ModelAdapter;

    const prepared = await withRuntimeContext(
      {
        requestId: "skill-fallback-request",
        threadId: "81aeeccd-dae0-4ea4-9d48-932f02c8d17c",
        userId: "skill-fallback-user",
        logger,
        events: { push: () => undefined }
      },
      async () =>
        await engine.prepare(
          {
            skillName: "workspace-inspection",
            reason: "test",
            mode: "serial",
            input: "Read README.md."
          },
          failedModel
        )
    );

    expect(prepared.toolPlan).toMatchObject({
      mode: "serial",
      calls: [{ toolName: "file_read", args: { path: "README.md" } }]
    });
    }
  );

  it("prepares independent file and HTTP skills in parallel from the homepage example", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger);
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "file_read",
      description: "test file reader",
      argsSchema: z.object({ path: z.string() }),
      risk: "low",
      execute: async () => ({})
    });
    registry.register({
      name: "http_request",
      description: "test HTTP client",
      argsSchema: z.object({
        url: z.string().url(),
        method: z.literal("GET")
      }),
      risk: "high",
      execute: async () => ({})
    });

    let persistedConfirmation: unknown;
    const threadStore = {
      setPendingConfirmation: async (_threadId: string, confirmation: unknown) => {
        persistedConfirmation = confirmation;
      }
    } as unknown as ThreadStore;
    const engine = new SkillEngine(
      {
        SKILL_PLAN_TIMEOUT_MS: 1,
        SKILL_TOOL_PLAN_FALLBACK_ENABLED: true
      } as never,
      loader,
      registry,
      {} as ToolExecutor,
      threadStore,
      logger
    );
    const timedOutModel = {
      helperMessages: () => [],
      invokeJson: async () => {
        throw new AppError("MODEL_TIMEOUT", "simulated skill planner timeout");
      }
    } as unknown as ModelAdapter;
    const message =
      "我正在整理两份互不依赖的资料：README.md 和 https://example.com。请同时收集它们的内容，最后统一汇总";

    const prepared = await withRuntimeContext(
      {
        requestId: "parallel-fallback-request",
        threadId: "9e55d25b-e4ce-48ce-804b-80e0c3953449",
        userId: "parallel-fallback-user",
        logger,
        events: { push: () => undefined }
      },
      async () =>
        await engine.prepareMany(
          [
            {
              skillName: "workspace-inspection",
              reason: "read local material",
              mode: "parallel",
              input: message
            },
            {
              skillName: "web-research",
              reason: "read external material",
              mode: "parallel",
              input: message
            }
          ],
          timedOutModel
        )
    );

    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.toolPlan).toMatchObject({
      mode: "parallel",
      calls: [{ toolName: "file_read", args: { path: "README.md" } }]
    });
    expect(prepared[1]).toMatchObject({
      requiresConfirmation: true,
      toolPlan: {
        mode: "parallel",
        calls: [
          {
            toolName: "http_request",
            args: { url: "https://example.com", method: "GET" }
          }
        ]
      }
    });
    expect(persistedConfirmation).toMatchObject({
      toolName: "http_request",
      args: { url: "https://example.com", method: "GET" }
    });
  });

  it("queues every high-risk call when web research contains multiple URLs", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger);
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "http_request",
      description: "test HTTP client",
      argsSchema: z.object({ url: z.string().url(), method: z.literal("GET") }),
      risk: "high",
      execute: async () => ({})
    });
    const engine = new SkillEngine(
      {
        SKILL_PLAN_TIMEOUT_MS: 1,
        SKILL_TOOL_PLAN_FALLBACK_ENABLED: true
      } as never,
      loader,
      registry,
      {} as ToolExecutor,
      {} as ThreadStore,
      logger
    );
    const timedOutModel = {
      helperMessages: () => [],
      invokeJson: async () => {
        throw new AppError("MODEL_TIMEOUT", "simulated skill planner timeout");
      }
    } as unknown as ModelAdapter;

    const prepared = await withRuntimeContext(
      {
        requestId: "multi-confirmation-request",
        threadId: "a15d8127-46c4-49fc-bb37-134c9c9cda97",
        userId: "multi-confirmation-user",
        logger,
        events: { push: () => undefined }
      },
      async () =>
        await engine.prepare(
          {
            skillName: "web-research",
            reason: "compare two pages",
            mode: "parallel",
            input: "同时比较 https://example.com 和 https://example.org 的内容"
          },
          timedOutModel
        )
    );

    expect(prepared.confirmations).toHaveLength(2);
    expect(prepared.confirmations.map((item) => item.args)).toEqual([
      { url: "https://example.com", method: "GET" },
      { url: "https://example.org", method: "GET" }
    ]);
  });

  it("deduplicates identical HTTP calls before requesting approval", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger);
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "http_request",
      description: "test HTTP client",
      argsSchema: z.object({ url: z.string().url(), method: z.literal("GET") }),
      risk: "high",
      execute: async () => ({})
    });
    const engine = new SkillEngine(
      { SKILL_TOOL_PLAN_FALLBACK_ENABLED: true } as never,
      loader,
      registry,
      {} as ToolExecutor,
      {} as ThreadStore,
      logger
    );
    const duplicatePlanModel = {
      helperMessages: () => [],
      invokeJson: async () => ({
        mode: "parallel",
        calls: [
          {
            toolName: "http_request",
            toolCallId: "duplicate-1",
            args: { url: "https://jsonplaceholder.typicode.com/todos/1", method: "GET" }
          },
          {
            toolName: "http_request",
            toolCallId: "duplicate-2",
            args: { url: "https://jsonplaceholder.typicode.com/todos/1", method: "GET" }
          }
        ]
      })
    } as unknown as ModelAdapter;

    const prepared = await withRuntimeContext(
      {
        requestId: "duplicate-plan-request",
        threadId: "c0e09fa5-b033-46c4-ae24-bb383af83785",
        userId: "duplicate-plan-user",
        logger,
        events: { push: () => undefined }
      },
      async () =>
        await engine.prepare(
          {
            skillName: "web-research",
            reason: "read one API",
            mode: "parallel",
            input: "访问 https://jsonplaceholder.typicode.com/todos/1"
          },
          duplicatePlanModel
        )
    );

    expect(prepared.toolPlan.calls).toHaveLength(1);
    expect(prepared.confirmations).toHaveLength(1);
    expect(prepared.confirmation?.args).toEqual({
      url: "https://jsonplaceholder.typicode.com/todos/1",
      method: "GET"
    });
  });

  it("authorizes high-risk tools by call id instead of a global approval", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const registry = new InMemoryToolRegistry();
    const executed: string[] = [];
    registry.register({
      name: "http_request",
      description: "test HTTP client",
      argsSchema: z.object({ url: z.string().url(), method: z.literal("GET") }),
      risk: "high",
      execute: async (args) => {
        const parsed = z
          .object({ url: z.string().url(), method: z.literal("GET") })
          .parse(args);
        executed.push(parsed.url);
        return { ok: true };
      }
    });
    let pendingToolCallId: string | undefined;
    const executor = new ToolExecutor(
      registry,
      {
        setPendingConfirmation: async (_threadId: string, confirmation: { toolCallId: string }) => {
          pendingToolCallId = confirmation.toolCallId;
          return confirmation;
        }
      } as unknown as ThreadStore,
      logger
    );

    await expect(
      withRuntimeContext(
        {
          requestId: "exact-approval-request",
          threadId: "79022814-9519-4f6c-9038-23cdeda3b9dc",
          userId: "exact-approval-user",
          logger,
          events: { push: () => undefined }
        },
        async () =>
          await executor.executeCalls(
            [
              {
                toolName: "http_request",
                toolCallId: "approved-call",
                args: { url: "https://example.com", method: "GET" }
              },
              {
                toolName: "http_request",
                toolCallId: "unapproved-call",
                args: { url: "https://example.org", method: "GET" }
              }
            ],
            "serial",
            {
              skillName: "web-research",
              executionMode: "serial",
              approvedHighRiskToolCallIds: ["approved-call"]
            }
          )
      )
    ).rejects.toBeInstanceOf(HumanConfirmationRequired);
    expect(executed).toEqual(["https://example.com"]);
    expect(pendingToolCallId).toBe("unapproved-call");
  });
});
