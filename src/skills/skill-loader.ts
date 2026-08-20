import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseSkillMetadata } from "@langchain/deepagents";
import { AppError } from "../common/errors.js";
import type { AppLogger } from "../common/logger.js";
import {
  LoadedSkillSchema,
  SkillFrontmatterSchema,
  SkillSummarySchema,
  type LoadedSkill,
  type SkillFrontmatter,
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
    private readonly skillsRoot: string,
    private readonly logger: AppLogger
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.scanDirectory(this.skillsRoot);
    this.initialized = true;
    this.logger.info(
      { skillsRoot: this.skillsRoot, count: this.summaries.size },
      "skills_indexed"
    );
  }

  async listSummaries(): Promise<SkillSummary[]> {
    await this.initialize();
    return [...this.summaries.values()];
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
    return LoadedSkillSchema.parse({
      ...summary,
      instructions: parsed.instructions
    });
  }

  async loadMany(skillNames: string[]): Promise<LoadedSkill[]> {
    return await Promise.all(skillNames.map((skillName) => this.load(skillName)));
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
        ...(parsedByDeepAgents
          ? {
              name: parsedByDeepAgents.name,
              description: parsedByDeepAgents.description,
              allowedTools: parsedByDeepAgents.allowedTools,
              compatibility: parsedByDeepAgents.compatibility,
              license: parsedByDeepAgents.license,
              metadata: parsedByDeepAgents.metadata
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
