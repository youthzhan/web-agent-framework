import { describe, expect, it } from "vitest";
import { routeSkillConversation } from "../src/skills/routing.js";
import type { SkillMatch } from "../src/skills/types.js";

function match(
  name: string,
  source: SkillMatch["source"],
  position: number
): SkillMatch {
  return {
    summary: {
      name,
      description: `${name} description`,
      allowedToolsList: [],
      triggers: [],
      routingKeywords: [],
      routingExcludes: [],
      directory: `skills/${name}`,
      filePath: `skills/${name}/SKILL.md`
    },
    source,
    score: source === "explicit" ? 1_000 : 10,
    position,
    matchedTriggers: source === "intent" ? [name] : []
  };
}

describe("conversational Skill routing", () => {
  it("directly invokes one explicitly named Skill", () => {
    const decision = routeSkillConversation(
      "使用 workspace-inspection 读取 README.md",
      [match("workspace-inspection", "explicit", 3)]
    );

    expect(decision).toMatchObject({
      source: "explicit",
      scheduling: "deterministic",
      plan: {
        skills: [{ skillName: "workspace-inspection", mode: "serial" }]
      }
    });
  });

  it("routes multiple Skills serially for an explicit dependency sequence", () => {
    const decision = routeSkillConversation(
      "先用 workspace-inspection 读取文件，然后用 web-research 查询网络",
      [
        match("workspace-inspection", "explicit", 3),
        match("web-research", "explicit", 39)
      ]
    );

    expect(decision.plan?.skills.map(({ skillName, mode }) => ({
      skillName,
      mode
    }))).toEqual([
      { skillName: "workspace-inspection", mode: "serial" },
      { skillName: "web-research", mode: "serial" }
    ]);
  });

  it("recognizes an English first-then dependency sequence", () => {
    const decision = routeSkillConversation(
      "First use workspace-inspection, then use web-research",
      [
        match("workspace-inspection", "explicit", 10),
        match("web-research", "explicit", 41)
      ]
    );

    expect(decision.plan?.skills.map((skill) => skill.mode)).toEqual([
      "serial",
      "serial"
    ]);
  });

  it("routes independent Skills in parallel when requested", () => {
    const decision = routeSkillConversation(
      "并行使用 workspace-inspection 和 web-research",
      [
        match("workspace-inspection", "explicit", 5),
        match("web-research", "explicit", 30)
      ]
    );

    expect(decision.plan?.skills.map((skill) => skill.mode)).toEqual([
      "parallel",
      "parallel"
    ]);
  });

  it("routes the homepage independent-research example in parallel", () => {
    const message =
      "我正在整理两份互不依赖的资料：README.md 和 https://example.com。请同时收集它们的内容，最后统一汇总";
    const decision = routeSkillConversation(message, [
      match("workspace-inspection", "intent", message.indexOf("README.md")),
      match("web-research", "intent", message.indexOf("https://"))
    ]);

    expect(decision).toMatchObject({
      source: "intent",
      scheduling: "deterministic"
    });
    expect(decision.plan?.skills.map((skill) => skill.mode)).toEqual([
      "parallel",
      "parallel"
    ]);
  });

  it("delegates ambiguous multi-Skill scheduling to the model", () => {
    const decision = routeSkillConversation(
      "读取文件并查询相关网站",
      [
        match("workspace-inspection", "intent", 0),
        match("web-research", "intent", 6)
      ]
    );

    expect(decision).toMatchObject({
      source: "intent",
      scheduling: "dynamic"
    });
    expect(decision.plan).toBeUndefined();
  });

  it("never executes a single semantic candidate without model judgment", () => {
    const decision = routeSkillConversation(
      "获取 OneDemo 场景中的机器人运行概况",
      [match("m4-scheduling", "semantic", 2)]
    );

    expect(decision).toMatchObject({
      source: "semantic",
      scheduling: "dynamic",
      matches: [{ source: "semantic" }]
    });
    expect(decision.plan).toBeUndefined();
  });
});
