import { resolveM4SkillsDir } from "m4-skills/skills";

/** Resolve the installed npm package instead of relying on a sibling checkout. */
export const m4SkillsRoot = resolveM4SkillsDir();
