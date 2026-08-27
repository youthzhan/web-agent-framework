import { AgentPlanSchema, type AgentPlan, type SkillMatch } from "./types.js";
import type { ToolExecutionMode } from "../tools/types.js";

export type SkillRoutingDecision = {
  source: "explicit" | "intent" | "semantic" | "model";
  scheduling: "deterministic" | "dynamic";
  matches: SkillMatch[];
  plan?: AgentPlan;
};

const MODE_CUES: Array<{ mode: ToolExecutionMode; pattern: RegExp }> = [
  { mode: "serial", pattern: /\bserial(?:ly)?\b|串行|依次|按顺序|逐个|先后/gi },
  { mode: "parallel", pattern: /\bparallel\b|并行|并发|同时|一起|互不依赖/gi }
];

/**
 * Converts clear conversational instructions into a validated Agent plan.
 * Ambiguous multi-Skill requests intentionally return no plan so the model can
 * decide whether the operations are dependent and choose serial/parallel mode.
 */
export function routeSkillConversation(
  message: string,
  matches: SkillMatch[]
): SkillRoutingDecision {
  if (matches.length === 0) {
    return { source: "model", scheduling: "dynamic", matches };
  }

  const source = matches.some((match) => match.source === "explicit")
    ? "explicit"
    : matches.some((match) => match.source === "intent")
      ? "intent"
      : "semantic";
  const cues = findModeCues(message);
  const hasDependencySequence = /先[\s\S]+?(?:再|然后|之后|最后)|基于[\s\S]+?(?:再|然后)|depends?\s+on|(?:first|after)[\s\S]+?then/i.test(
    message
  );

  // One Skill does not need cross-Skill scheduling. Its internal tool planner
  // still makes an independent serial/parallel decision for tool calls.
  // Semantic recall only supplies candidates. Even with one candidate, the
  // model must judge whether the user's intent really belongs to that Skill.
  if (matches.length === 1 && source !== "semantic") {
    return {
      source,
      scheduling: "deterministic",
      matches,
      plan: createPlan(message, matches, ["serial"])
    };
  }

  if (hasDependencySequence) {
    return {
      source,
      scheduling: "deterministic",
      matches,
      plan: createPlan(message, matches, matches.map(() => "serial"))
    };
  }

  if (cues.length === 1) {
    return {
      source,
      scheduling: "deterministic",
      matches,
      plan: createPlan(message, matches, matches.map(() => cues[0]!.mode))
    };
  }

  if (cues.length > 1) {
    const modes = matches.map((match) => modeBeforePosition(cues, match.position));
    return {
      source,
      scheduling: "deterministic",
      matches,
      plan: createPlan(message, matches, modes)
    };
  }

  // Multiple matched Skills with no scheduling instruction are delegated to
  // the model planner. Explicit names remain mandatory in that model plan.
  return { source, scheduling: "dynamic", matches };
}

export function createSerialFallbackPlan(
  message: string,
  matches: SkillMatch[]
): AgentPlan {
  return createPlan(message, matches, matches.map(() => "serial"));
}

function createPlan(
  message: string,
  matches: SkillMatch[],
  modes: ToolExecutionMode[]
): AgentPlan {
  return AgentPlanSchema.parse({
    directAnswer: false,
    skills: matches.map((match, index) => ({
      skillName: match.summary.name,
      reason:
        match.source === "explicit"
          ? "用户在对话中直接指定了该 Skill。"
          : match.source === "semantic"
            ? `语义召回候选：${match.matchedTriggers.join(", ")}`
            : `用户意图命中触发词：${match.matchedTriggers.join(", ")}`,
      mode: modes[index] ?? "serial",
      input: message
    }))
  });
}

function findModeCues(
  message: string
): Array<{ mode: ToolExecutionMode; position: number }> {
  return MODE_CUES.flatMap(({ mode, pattern }) =>
    [...message.matchAll(pattern)].map((match) => ({
      mode,
      position: match.index ?? 0
    }))
  ).sort((left, right) => left.position - right.position);
}

function modeBeforePosition(
  cues: Array<{ mode: ToolExecutionMode; position: number }>,
  position: number
): ToolExecutionMode {
  return [...cues]
    .reverse()
    .find((cue) => cue.position <= position)?.mode ?? cues[0]?.mode ?? "serial";
}
