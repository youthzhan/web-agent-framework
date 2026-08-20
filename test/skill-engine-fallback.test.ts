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
import type { ToolExecutor } from "../src/tools/executor.js";
import { InMemoryToolRegistry } from "../src/tools/registry.js";

describe("skill tool-plan fallback", () => {
  it("derives a validated sandbox file call only after a planner timeout", async () => {
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
    const timedOutModel = {
      helperMessages: () => [],
      invokeJson: async () => {
        throw new AppError("MODEL_TIMEOUT", "simulated skill planner timeout");
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
          timedOutModel
        )
    );

    expect(prepared.toolPlan).toMatchObject({
      mode: "serial",
      calls: [{ toolName: "file_read", args: { path: "README.md" } }]
    });
  });
});
