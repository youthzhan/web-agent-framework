import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseSkillMetadata } from "@langchain/deepagents";
import { AppError } from "../common/errors.js";
import type { AppLogger } from "../common/logger.js";
import {
  LoadedSkillSchema,
  SkillFrontmatterSchema,
  SkillMatchSchema,
  SkillSummarySchema,
  type LoadedSkill,
  type SkillFrontmatter,
  type SkillMatch,
  type SkillSummary
} from "./types.js";

function parseSkillDocument(content: string): {
  frontmatter: SkillFrontmatter;
  instructions: string;
} {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match?.[1] || match[2] === undefined) {
    throw new AppError("BAD_REQUEST", "SKILL.md must contain YAML frontmatter");
  }
  const frontmatter = SkillFrontmatterSchema.parse(YAML.parse(match[1]));
  return {
    frontmatter,
    instructions: match[2].trim()
  };
}

function splitAllowedTools(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

export class SkillLoader {
  private readonly summaries = new Map<string, SkillSummary>();
  private initialized = false;

  constructor(
    private readonly skillsRoots: string | readonly string[],
    private readonly logger: AppLogger
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const roots = typeof this.skillsRoots === "string"
      ? [this.skillsRoots]
      : [...this.skillsRoots];
    for (const root of roots) {
      await this.scanDirectory(root);
    }
    this.initialized = true;
    this.logger.info(
      { skillsRoots: roots, count: this.summaries.size },
      "skills_indexed"
    );
  }

  async listSummaries(): Promise<SkillSummary[]> {
    await this.initialize();
    return [...this.summaries.values()];
  }

  /**
   * Returns skills that can be safely selected without an LLM planner. This
   * handles explicit skill requests and planner timeout fallback while the
   * normal path still uses model-based dynamic routing.
   */
  async findMatches(input: string): Promise<SkillSummary[]> {
    return (await this.findMatchDetails(input)).map((match) => match.summary);
  }

  /**
   * Recalls a small set of semantic candidates when no explicit name or
   * frontmatter trigger matched. This is intentionally local and explainable:
   * it uses normalized terms from the Skill metadata, while the model planner
   * remains responsible for the final selection.
   */
  async findSemanticCandidates(
    input: string,
    limit = 3
  ): Promise<SkillMatch[]> {
    await this.initialize();
    const normalizedInput = normalizeRoutingText(input);
    const inputTerms = extractRoutingTerms(normalizedInput);
    if (inputTerms.length === 0) {
      return [];
    }

    const scored = [...this.summaries.values()]
      .map((summary) => {
        const keywords = routingKeywords(summary);
        const searchableText = keywords.join(" ").toLocaleLowerCase();
        const directKeywordHits = keywords.filter((keyword) =>
          keyword.length > 1 && containsRoutingPhrase(normalizedInput, keyword)
        );
        const matchedTerms = inputTerms.filter((term) =>
          searchableText.includes(term)
        );
        const uniqueMatchedTerms = collapseRoutingTerms([
          ...new Set([...directKeywordHits, ...matchedTerms])
        ]);
        const excludedHits = summary.routingExcludes
          .map(normalizeRoutingText)
          .filter((keyword) => keyword.length > 1 && containsRoutingPhrase(normalizedInput, keyword));
        const phraseScore = directKeywordHits.reduce(
          (total, phrase) => total + (phrase.length >= 4 ? 32 : 24),
          0
        );
        const termScore = collapseRoutingTerms([...new Set(matchedTerms)])
          .reduce((total, term) => total + (term.length >= 3 ? 8 : 4), 0);
        const excludePenalty = excludedHits.length * 28;
        const score = phraseScore + termScore - excludePenalty;
        const hasEnoughSignal =
          directKeywordHits.length > 0 || uniqueMatchedTerms.length >= 2;
        return {
          summary,
          score,
          matchedTerms: uniqueMatchedTerms,
          position: findFirstTermPosition(normalizedInput, uniqueMatchedTerms),
          excludedHits,
          directKeywordHitCount: directKeywordHits.length,
          hasEnoughSignal
        };
      })
      .filter((item) =>
        item.hasEnoughSignal &&
        item.score >= 20 &&
        (item.excludedHits.length === 0 || item.directKeywordHitCount >= 2)
      )
      .sort((left, right) =>
        right.score - left.score || left.position - right.position
      )
      .slice(0, Math.max(1, Math.min(limit, 5)));

    return scored.map((item) =>
      SkillMatchSchema.parse({
        summary: item.summary,
        source: "semantic",
        score: item.score,
        position: item.position,
        matchedTriggers: item.matchedTerms.slice(0, 8)
      })
    );
  }

  /**
   * Distinguishes a direct Skill name from a trigger-based intent match. ASCII
   * triggers use word boundaries so values such as `file` do not match
   * unrelated words such as `profile`.
   */
  async findMatchDetails(input: string): Promise<SkillMatch[]> {
    await this.initialize();
    const normalizedInput = normalizeRoutingText(input);
    const scored = [...this.summaries.values()]
      .map((summary) => {
        const normalizedName = summary.name.toLocaleLowerCase();
        const namePosition = normalizedInput.indexOf(normalizedName);
        const nameMatch = namePosition >= 0;
        const triggerMatches = summary.triggers.filter((trigger) =>
          matchesTrigger(normalizedInput, trigger.toLocaleLowerCase())
        );
        const triggerPositions = triggerMatches.map((trigger) =>
          findTriggerPosition(normalizedInput, trigger.toLocaleLowerCase())
        );
        return {
          summary,
          score: nameMatch ? 1000 : triggerMatches.length * 10,
          nameMatch,
          matchedTriggers: triggerMatches,
          position: nameMatch
            ? namePosition
            : Math.min(...triggerPositions.filter((position) => position >= 0))
        };
      })
      .filter((item) => item.nameMatch || item.matchedTriggers.length > 0)
      .sort((left, right) => right.score - left.score || left.position - right.position);

    const explicit = scored.filter((item) => item.nameMatch);
    if (explicit.length > 0) {
      const explicitNames = new Set(
        explicit.map((item) => item.summary.name)
      );
      const selected = [
        ...explicit,
        ...scored
          .filter((item) => !explicitNames.has(item.summary.name))
          .slice(0, Math.max(0, 3 - explicit.length))
      ];
      return selected
        .sort((left, right) => left.position - right.position)
        .map((item) =>
          SkillMatchSchema.parse({
            summary: item.summary,
            source: item.nameMatch ? "explicit" : "intent",
            score: item.score,
            position: item.position,
            matchedTriggers: item.matchedTriggers
          })
        );
    }
    return scored
      .filter((item) => item.matchedTriggers.length > 0)
      .slice(0, 3)
      .sort((left, right) => left.position - right.position)
      .map((item) =>
        SkillMatchSchema.parse({
          summary: item.summary,
          source: "intent",
          score: item.score,
          position: item.position,
          matchedTriggers: item.matchedTriggers
        })
      );
  }

  async load(skillName: string): Promise<LoadedSkill> {
    await this.initialize();
    const summary = this.summaries.get(skillName);
    if (!summary) {
      throw new AppError("BAD_REQUEST", `Skill not found: ${skillName}`, {
        statusCode: 404
      });
    }
    const content = await fs.readFile(summary.filePath, "utf8");
    const parsed = parseSkillDocument(content);
    const references = await this.loadReferences(
      summary.directory,
      parsed.instructions
    );
    return LoadedSkillSchema.parse({
      ...summary,
      instructions:
        references.length === 0
          ? parsed.instructions
          : [
              parsed.instructions,
              "## 参考接口文档",
              ...references.map(
                (reference) =>
                  `### ${reference.name}\n\n${reference.content}`
              )
            ].join("\n\n")
    });
  }

  async loadMany(skillNames: string[]): Promise<LoadedSkill[]> {
    return await Promise.all(skillNames.map((skillName) => this.load(skillName)));
  }

  private async loadReferences(
    directory: string,
    instructions: string
  ): Promise<
    Array<{ name: string; content: string }>
  > {
    const referencePaths = new Set<string>();
    const referencesDirectory = path.join(directory, "references");
    try {
      const entries = await fs.readdir(referencesDirectory, {
        withFileTypes: true
      });
      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.toLocaleLowerCase().endsWith(".md")
        ) {
          referencePaths.add(path.join(referencesDirectory, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    // Skill instructions may link to a shared protocol document outside the
    // per-Skill references directory. Resolve only local Markdown links.
    for (const match of instructions.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/gi)) {
      const link = match[1];
      if (!link || /^[a-z]+:/i.test(link)) {
        continue;
      }
      referencePaths.add(path.resolve(directory, link));
    }

    const files = [...referencePaths].sort((left, right) =>
      left.localeCompare(right)
    );
    const loaded: Array<{ name: string; content: string }> = [];
    for (const filePath of files) {
      try {
        const content = (await fs.readFile(filePath, "utf8")).trim();
        if (content) {
          loaded.push({
            name: path.relative(directory, filePath).replaceAll("\\", "/"),
            content
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return loaded;
  }

  private async scanDirectory(directory: string): Promise<void> {
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
      if (entry.isDirectory()) {
        await this.scanDirectory(entryPath);
        continue;
      }
      if (entry.name !== "SKILL.md") {
        continue;
      }

      const content = await fs.readFile(entryPath, "utf8");
      const parsedByDeepAgents = parseSkillMetadata(entryPath, "project");
      const { frontmatter } = parseSkillDocument(content);
      const normalized = SkillFrontmatterSchema.parse({
        ...frontmatter,
        // DeepAgents currently returns the standard name/description/path
        // fields but not this application's tool ACL metadata. Keep the YAML
        // `allowedTools` value authoritative so a missing optional field can
        // never silently widen or remove a skill's tool permissions.
        ...(parsedByDeepAgents
          ? {
              name: parsedByDeepAgents.name,
              description: parsedByDeepAgents.description,
              ...(frontmatter.allowedTools === undefined
                ? {}
                : { allowedTools: frontmatter.allowedTools }),
              triggers: frontmatter.triggers,
              routingKeywords: frontmatter.routingKeywords,
              routingExcludes: frontmatter.routingExcludes,
              ...(frontmatter.operations === undefined
                ? {}
                : { operations: frontmatter.operations }),
              // Application metadata is an ACL/routing contract. Keep the
              // YAML value authoritative instead of allowing the external
              // parser to normalize or drop custom keys.
              ...(frontmatter.compatibility === undefined
                ? {}
                : { compatibility: frontmatter.compatibility }),
              ...(frontmatter.license === undefined
                ? {}
                : { license: frontmatter.license }),
              ...(frontmatter.metadata === undefined
                ? {}
                : { metadata: frontmatter.metadata })
            }
          : {})
      });
      const summary = SkillSummarySchema.parse({
        ...normalized,
        directory: path.dirname(entryPath),
        filePath: entryPath,
        allowedToolsList: splitAllowedTools(normalized.allowedTools)
      });
      this.summaries.set(summary.name, summary);
    }
  }
}

function matchesTrigger(input: string, trigger: string): boolean {
  input = normalizeRoutingText(input);
  trigger = normalizeRoutingText(trigger);
  if (!/^[a-z0-9_-]+$/i.test(trigger)) {
    if (input.includes(trigger)) {
      return true;
    }
    // Chinese intent triggers are often interrupted by a concrete entity,
    // e.g. "查询机器人 Jack-08 的状态" for the trigger "机器人状态".
    // Preserve trigger order while allowing a bounded natural-language gap.
    if (/^[\u4e00-\u9fff]+$/.test(trigger)) {
      let cursor = 0;
      for (const character of trigger) {
        const position = input.indexOf(character, cursor);
        if (position < 0 || position - cursor > 48) {
          return false;
        }
        const gap = input.slice(cursor, position);
        if (!isAllowedChineseTriggerGap(gap)) {
          return false;
        }
        cursor = position + character.length;
      }
      return true;
    }
    return false;
  }
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`, "i").test(
    input
  );
}

function isAllowedChineseTriggerGap(gap: string): boolean {
  const compact = gap.replace(/[\s\u3000]/g, "");
  if (!compact || /[a-z0-9_-]/i.test(compact)) {
    return true;
  }
  // Gaps containing workflow/action connectors usually join two separate
  // intents. Do not let a generic phrase such as "任务状态" match inside
  // "搬运任务的执行状态" and incorrectly select the Falcon Skill.
  return !/(执行|作业|处理|完成|创建|取消|然后|并且|并|和|与)/.test(compact);
}

function findTriggerPosition(input: string, trigger: string): number {
  const normalizedInput = normalizeRoutingText(input);
  const normalizedTrigger = normalizeRoutingText(trigger);
  const directPosition = normalizedInput.indexOf(normalizedTrigger);
  if (directPosition >= 0) {
    return directPosition;
  }
  return normalizedInput.indexOf(normalizedTrigger[0] ?? "");
}

function normalizeRoutingText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u3000\t\r\n]+/g, " ")
    .replace(/[，。！？、：；（）【】「」『』“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsRoutingPhrase(input: string, phrase: string): boolean {
  if (/^[a-z0-9_-]+(?: [a-z0-9_-]+)*$/i.test(phrase)) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`,
      "i"
    ).test(input);
  }
  return input.includes(phrase);
}

function routingKeywords(summary: SkillSummary): string[] {
  const metadataKeywords = (summary.metadata?.routingKeywords ?? "")
    .split(/[,，;；|\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const result = [...new Set([
    ...summary.routingKeywords,
    ...summary.triggers,
    // Minimal Skills may intentionally expose only name/description in
    // frontmatter. Their domain vocabulary must still participate in local
    // semantic recall without requiring custom routing metadata.
    summary.description,
    ...extractRoutingTerms(normalizeRoutingText(summary.description)),
    ...metadataKeywords,
    summary.metadata?.domain ?? "",
    ...(summary.metadata?.capabilities ?? "").split(/[,，;；|\s]+/)
  ].filter(Boolean).map(normalizeRoutingText))];
  return result;
}

const ROUTING_STOP_WORDS = new Set([
  "请", "帮", "我", "想", "要", "给", "下", "中", "的", "和", "并",
  "一下", "一个", "这个", "那个", "获取", "查询", "查看", "当前", "所有",
  "全部", "相关", "情况", "信息", "please", "help", "the", "a", "an", "to",
  "for", "and", "is", "are"
]);

function extractRoutingTerms(input: string): string[] {
  const normalized = input.toLocaleLowerCase();
  const terms = [
    ...normalized.matchAll(/[a-z][a-z0-9_-]*/g)
  ].map((match) => match[0] ?? "");
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0] ?? "";
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        terms.push(run.slice(index, index + size));
      }
    }
  }
  return [...new Set(terms)].filter(
    (term) => term.length > 0 && !ROUTING_STOP_WORDS.has(term)
  );
}

function findFirstTermPosition(input: string, terms: string[]): number {
  const normalized = input.toLocaleLowerCase();
  return Math.min(
    ...terms
      .map((term) => normalized.indexOf(term))
      .filter((position) => position >= 0),
    0
  );
}

/** Avoid counting overlapping Chinese n-grams such as "场景", "的场" and
 * "的场景" as three independent semantic signals. Longer phrases carry the
 * intent, while shorter substrings are only retained when they add new text.
 */
function collapseRoutingTerms(terms: string[]): string[] {
  return terms
    .sort((left, right) => right.length - left.length)
    .filter(
      (term, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex < index && other.length > term.length && other.includes(term)
        )
    );
}
