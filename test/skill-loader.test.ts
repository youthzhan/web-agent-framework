import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/common/logger.js";
import { SkillLoader } from "../src/skills/skill-loader.js";
import { m4SkillsRoot } from "./m4-skills-path.js";

const logger = () => createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);

describe("skill loader", () => {
  it("indexes metadata first and loads full instructions on demand", async () => {
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger());
    const summaries = await loader.listSummaries();
    expect(summaries.map((skill) => skill.name).sort()).toEqual([
      "web-research",
      "workspace-inspection"
    ]);
    expect(summaries[0]).not.toHaveProperty("instructions");

    const loaded = await loader.load("workspace-inspection");
    expect(loaded.allowedToolsList).toEqual(["file_read"]);
    expect(loaded.instructions).toContain("配置的沙箱目录");
  });

  it("matches explicit names before trigger-based lazy routing", async () => {
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger());
    await expect(loader.findMatches("Use workspace-inspection to read README.md"))
      .resolves.toMatchObject([{ name: "workspace-inspection" }]);
    await expect(loader.findMatches("读取工作区里的文件"))
      .resolves.toMatchObject([{ name: "workspace-inspection" }]);
  });

  it("indexes multiple independent skill roots", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-roots-"));
    const externalRoot = path.join(tempRoot, "external");
    await fs.mkdir(path.join(externalRoot, "minimal-example"), { recursive: true });
    await fs.writeFile(
      path.join(externalRoot, "minimal-example", "SKILL.md"),
      [
        "---",
        "name: minimal-example",
        "description: external skill",
        "---",
        "",
        "External skill instructions."
      ].join("\n"),
      "utf8"
    );

    try {
      const loader = new SkillLoader(
        [path.resolve(process.cwd(), "skills"), externalRoot],
        logger()
      );
      await expect(loader.findMatches("use minimal-example"))
        .resolves.toMatchObject([{ name: "minimal-example" }]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads references for a minimal Skill", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-references-"));
    const skillRoot = path.join(tempRoot, "external-scheduling");
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: external-scheduling",
        "description: external scheduling skill",
        "---",
        "",
        "Use the scheduling API."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(skillRoot, "references", "api.md"), "POST /api/entity/find/one", "utf8");

    try {
      const loaded = await new SkillLoader(tempRoot, logger()).load("external-scheduling");
      expect(loaded.instructions).toContain("Use the scheduling API.");
      expect(loaded.instructions).toContain("POST /api/entity/find/one");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads only the scheduling Skill from the M4 package", async () => {
    const loader = new SkillLoader(m4SkillsRoot, logger());
    const summaries = await loader.listSummaries();
    expect(summaries.map((skill) => skill.name)).toEqual(["m4-scheduling"]);
    expect(summaries[0]).toMatchObject({
      description: expect.stringContaining("TransportOrder"),
      routingKeywords: [],
      routingExcludes: [],
      allowedToolsList: []
    });
    expect(summaries[0]).not.toHaveProperty("metadata");
    expect(summaries[0]).not.toHaveProperty("operations");
  });

  it("uses the description for semantic recall when metadata is minimal", async () => {
    const loader = new SkillLoader(m4SkillsRoot, logger());
    const candidates = await loader.findSemanticCandidates("查询运输单执行状态");
    expect(candidates[0]).toMatchObject({
      summary: { name: "m4-scheduling" },
      source: "semantic"
    });
  });
});
