import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/common/logger.js";
import { SkillLoader } from "../src/skills/skill-loader.js";

describe("skill loader", () => {
  it("indexes metadata first and loads full instructions on demand", async () => {
    const logger = createLogger({
      NODE_ENV: "test",
      LOG_LEVEL: "silent"
    } as never);
    const loader = new SkillLoader(
      path.resolve(process.cwd(), "skills"),
      logger
    );

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
    const logger = createLogger({
      NODE_ENV: "test",
      LOG_LEVEL: "silent"
    } as never);
    const loader = new SkillLoader(
      path.resolve(process.cwd(), "skills"),
      logger
    );

    await expect(
      loader.findMatches("Use workspace-inspection to read README.md")
    ).resolves.toMatchObject([{ name: "workspace-inspection" }]);
    await expect(loader.findMatches("\u8bfb\u53d6\u5de5\u4f5c\u533a\u91cc\u7684\u6587\u4ef6")).resolves.toMatchObject([
      { name: "workspace-inspection" }
    ]);
  });

  it("distinguishes direct Skill invocation from intent matching", async () => {
    const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" } as never);
    const loader = new SkillLoader(path.resolve(process.cwd(), "skills"), logger);

    await expect(
      loader.findMatchDetails("使用 web-research 访问 https://example.com")
    ).resolves.toMatchObject([
      { source: "explicit", summary: { name: "web-research" } }
    ]);
    await expect(
      loader.findMatchDetails("读取 README.md 并查询 https://example.com")
    ).resolves.toMatchObject([
      { source: "intent", summary: { name: "workspace-inspection" } },
      { source: "intent", summary: { name: "web-research" } }
    ]);
    await expect(
      loader.findMatchDetails(
        "使用 workspace-inspection 读取 README.md，并查询 https://example.com"
      )
    ).resolves.toMatchObject([
      { source: "explicit", summary: { name: "workspace-inspection" } },
      { source: "intent", summary: { name: "web-research" } }
    ]);
  });
});
