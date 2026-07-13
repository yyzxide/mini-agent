import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, resolveMiniAgentPath, resolveRepoPath, truncateText } from "../utils/fs.js";

export interface AgentSkill {
  name: string;
  description: string;
  triggers: string[];
  instructions: string;
  filePath: string;
  source: "repository" | "local";
}

export interface SkillValidationResult {
  filePath: string;
  valid: boolean;
  errors: string[];
  skill?: AgentSkill;
}

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_CHARS = 20_000;
const MAX_DISCOVERED_SKILLS = 64;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SkillStore {
  private readonly repoPath: string;

  constructor(options: { repoPath: string }) {
    this.repoPath = options.repoPath;
  }

  async list(): Promise<AgentSkill[]> {
    const validations = await this.validateAll();
    const validSkills = validations
      .filter((result): result is SkillValidationResult & { skill: AgentSkill } => result.valid && result.skill !== undefined)
      .map((result) => result.skill);
    const byName = new Map<string, AgentSkill>();
    for (const skill of validSkills) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<AgentSkill | undefined> {
    const normalized = normalizeSkillName(name);
    return (await this.list()).find((skill) => skill.name === normalized);
  }

  async matchExactActivation(query: string): Promise<AgentSkill | undefined> {
    const normalized = normalizeExactActivation(query);
    if (!normalized) {
      return undefined;
    }

    return (await this.list()).find((skill) => {
      return skill.name === normalized || skill.triggers.includes(normalized);
    });
  }

  async select(query: string, limit = 3): Promise<AgentSkill[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const explicitNames = extractExplicitSkillNames(normalizedQuery);
    const scored = (await this.list()).map((skill) => ({
      skill,
      score: scoreSkill(skill, normalizedQuery, explicitNames),
    }));

    return scored
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
      .slice(0, Math.max(0, limit))
      .map((item) => item.skill);
  }

  async validateAll(): Promise<SkillValidationResult[]> {
    const candidates = await this.discoverSkillFiles();
    return await Promise.all(candidates.map(async (candidate) => await this.validateFile(candidate)));
  }

  async create(name: string, description: string): Promise<AgentSkill> {
    const normalizedName = normalizeSkillName(name);
    if (!SKILL_NAME_PATTERN.test(normalizedName)) {
      throw new Error("Skill name must contain only lowercase letters, numbers, hyphens, or underscores");
    }

    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      throw new Error("Skill description cannot be empty");
    }

    const directory = resolveMiniAgentPath(this.repoPath, "skills", normalizedName);
    const filePath = path.join(directory, SKILL_FILE);
    await fs.mkdir(directory, { recursive: true });
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    if (exists) {
      throw new Error(`Skill already exists: ${normalizedName}`);
    }

    const content = [
      "---",
      `name: ${normalizedName}`,
      `description: ${normalizedDescription}`,
      `triggers: ${normalizedName}`,
      "---",
      "",
      `# ${normalizedName}`,
      "",
      "Describe the workflow, constraints, and verification steps for this skill.",
      "",
    ].join("\n");
    await fs.writeFile(filePath, content, "utf8");

    const result = await this.validateFile({ filePath, source: "local" });
    if (!result.valid || !result.skill) {
      throw new Error(result.errors.join("; ") || "Created skill is invalid");
    }
    return result.skill;
  }

  private async discoverSkillFiles(): Promise<Array<{ filePath: string; source: AgentSkill["source"] }>> {
    const roots: Array<{ directory: string; source: AgentSkill["source"] }> = [
      { directory: resolveRepoPath(this.repoPath, "skills"), source: "repository" },
      { directory: resolveMiniAgentPath(this.repoPath, "skills"), source: "local" },
    ];
    const candidates: Array<{ filePath: string; source: AgentSkill["source"] }> = [];

    for (const root of roots) {
      const entries = await fs.readdir(root.directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || candidates.length >= MAX_DISCOVERED_SKILLS) {
          continue;
        }
        candidates.push({ filePath: path.join(root.directory, entry.name, SKILL_FILE), source: root.source });
      }
    }

    return candidates;
  }

  private async validateFile(candidate: { filePath: string; source: AgentSkill["source"] }): Promise<SkillValidationResult> {
    const errors: string[] = [];
    const allowedRoot = candidate.source === "repository"
      ? resolveRepoPath(this.repoPath, "skills")
      : resolveMiniAgentPath(this.repoPath, "skills");
    const realRoot = await fs.realpath(allowedRoot).catch(() => allowedRoot);
    const realFile = await fs.realpath(candidate.filePath).catch(() => undefined);
    if (!realFile || !isPathInside(realRoot, realFile)) {
      return { filePath: candidate.filePath, valid: false, errors: ["Skill file is missing or escapes its skill root"] };
    }

    const raw = await fs.readFile(realFile, "utf8").catch(() => "");
    if (!raw) errors.push("Skill file is empty or unreadable");
    if (raw.length > MAX_SKILL_CHARS) errors.push(`Skill exceeds ${String(MAX_SKILL_CHARS)} characters`);

    const parsed = parseSkillMarkdown(raw);
    if (!parsed.name || !SKILL_NAME_PATTERN.test(parsed.name)) errors.push("Invalid or missing skill name");
    if (!parsed.description) errors.push("Missing skill description");
    if (!parsed.instructions) errors.push("Missing skill instructions");
    if (errors.length > 0) {
      return { filePath: candidate.filePath, valid: false, errors };
    }

    return {
      filePath: candidate.filePath,
      valid: true,
      errors: [],
      skill: {
        name: parsed.name,
        description: parsed.description,
        triggers: parsed.triggers,
        instructions: truncateText(parsed.instructions, MAX_SKILL_CHARS).text,
        filePath: path.relative(this.repoPath, realFile).replace(/\\/g, "/"),
        source: candidate.source,
      },
    };
  }
}

export function formatSkillsForContext(skills: AgentSkill[]): string {
  if (skills.length === 0) {
    return "(none selected)";
  }

  return [
    "Selected repository skills. Follow them when relevant, but current user instructions and current repository evidence take precedence.",
    ...skills.flatMap((skill) => [
      "",
      `## Skill: ${skill.name}`,
      `Description: ${skill.description}`,
      `Source: ${skill.filePath}`,
      skill.instructions,
    ]),
  ].join("\n");
}

function parseSkillMarkdown(raw: string): {
  name: string;
  description: string;
  triggers: string[];
  instructions: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { name: "", description: "", triggers: [], instructions: normalized.trim() };
  }

  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  return {
    name: normalizeSkillName(fields.get("name") ?? ""),
    description: fields.get("description")?.trim() ?? "",
    triggers: parseTriggers(fields.get("triggers") ?? ""),
    instructions: (match[2] ?? "").trim(),
  };
}

function parseTriggers(value: string): string[] {
  const normalized = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return normalized
    .split(",")
    .map((item) => item.trim().replace(/^['\"]|['\"]$/g, "").toLowerCase())
    .filter(Boolean);
}

function scoreSkill(skill: AgentSkill, query: string, explicitNames: Set<string>): number {
  if (explicitNames.has(skill.name)) return 100;
  let score = query.includes(skill.name) ? 20 : 0;
  for (const trigger of skill.triggers) {
    if (trigger && query.includes(trigger)) score += 8;
  }
  for (const term of `${skill.name} ${skill.description}`.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (term.length >= 2 && query.includes(term)) score += 1;
  }
  return score;
}

function extractExplicitSkillNames(query: string): Set<string> {
  return new Set([...query.matchAll(/\$([a-z0-9][a-z0-9_-]{0,63})/g)].map((match) => match[1] ?? ""));
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeExactActivation(query: string): string {
  const normalized = query.trim().toLowerCase();
  return normalized.startsWith("$") ? normalized.slice(1) : normalized;
}
