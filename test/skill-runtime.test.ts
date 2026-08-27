import { describe, expect, it } from "vitest";
import { createLogger } from "../src/common/logger.js";
import { InMemoryToolRegistry } from "../src/tools/registry.js";
import { registerSkillRuntimeTools } from "../src/tools/skill-runtime.js";
import { m4SkillsRoot } from "./m4-skills-path.js";

describe("Skill runtime discovery", () => {
  it("loads tools from a Skill package manifest without M4-specific registration", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const registry = new InMemoryToolRegistry();
    const registered = await registerSkillRuntimeTools(
      [m4SkillsRoot],
      {
        M4_BASE_URL: "http://localhost:5800",
        M4_AUTH_MODE: "header"
      } as never,
      registry,
      logger
    );

    expect(registered).toEqual(["m4_read", "m4_write"]);
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "m4_read",
      "m4_write"
    ]);
  });
});
