import { describe, expect, it } from "vitest";
import { createLogger } from "../src/common/logger.js";
import { SkillLoader } from "../src/skills/skill-loader.js";
import { m4SkillsRoot } from "./m4-skills-path.js";

describe("M4 scheduling Skill", () => {
  it("loads the single scheduling Skill with minimal metadata", async () => {
    const loader = new SkillLoader(
      m4SkillsRoot,
      createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never)
    );

    const summaries = await loader.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      name: "m4-scheduling",
      description: expect.stringContaining("TransportOrder"),
      allowedToolsList: [],
      routingKeywords: [],
      routingExcludes: []
    });
    expect(summaries[0]).not.toHaveProperty("metadata");
    expect(summaries[0]).not.toHaveProperty("operations");

    const loaded = await loader.load("m4-scheduling");
    expect(loaded.instructions).toContain("M4 调度系统 Skill");
    expect(loaded.instructions).toContain("创建运单");
    expect(loaded.instructions).toContain("CreateOrderReq");
  });

  it("recalls scheduling requests from the description without custom metadata", async () => {
    const loader = new SkillLoader(
      m4SkillsRoot,
      createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never)
    );

    const candidates = await loader.findSemanticCandidates("查询运输单的执行状态");
    expect(candidates[0]).toMatchObject({
      summary: { name: "m4-scheduling" },
      source: "semantic"
    });
  });
});
