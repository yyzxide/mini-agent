import fs from "node:fs/promises";
import path from "node:path";
import { GitManager } from "../git/GitManager.js";
import {
  DEFAULT_IGNORED_NAMES,
  isIgnoredRelativePath,
  normalizeRepoPath,
  toPosixPath,
  truncateText,
} from "../utils/fs.js";

export interface RepoScannerOptions {
  repoPath: string;
  maxTreeItems?: number;
  maxFileChars?: number;
}

export class RepoScanner {
  readonly repoPath: string;
  private readonly maxTreeItems: number;
  private readonly maxFileChars: number;

  constructor(options: RepoScannerOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.maxTreeItems = options.maxTreeItems ?? 200;
    this.maxFileChars = options.maxFileChars ?? 4_000;
  }

  async isGitRepository(): Promise<boolean> {
    return await new GitManager({ repoPath: this.repoPath }).isGitRepository();
  }

  async getTreeSummary(): Promise<string> {
    const items: string[] = [];
    await this.walk(this.repoPath, 0, items);
    return items.join("\n");
  }

  async readReadmeSummary(): Promise<string> {
    const candidates = ["README.md", "README.txt", "README"];
    for (const candidate of candidates) {
      const content = await this.readOptionalFile(candidate);
      if (content !== undefined) {
        return `# ${candidate}\n${content}`;
      }
    }

    return "README not found.";
  }

  async readBuildFileSummary(): Promise<string> {
    const candidates = ["package.json", "pnpm-lock.yaml", "pom.xml", "go.mod", "CMakeLists.txt", "build.gradle", "settings.gradle"];
    const sections: string[] = [];

    for (const candidate of candidates) {
      const content = await this.readOptionalFile(candidate);
      if (content !== undefined) {
        sections.push(`# ${candidate}\n${content}`);
      }
    }

    return sections.length > 0 ? sections.join("\n\n") : "No common build files found.";
  }

  private async walk(directoryPath: string, depth: number, items: string[]): Promise<void> {
    if (items.length >= this.maxTreeItems || depth > 3) {
      return;
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (items.length >= this.maxTreeItems) {
        return;
      }

      if (DEFAULT_IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toPosixPath(path.relative(this.repoPath, absolutePath));
      if (isIgnoredRelativePath(relativePath)) {
        continue;
      }

      items.push(`${entry.isDirectory() ? "dir " : "file"} ${relativePath}`);
      if (entry.isDirectory()) {
        await this.walk(absolutePath, depth + 1, items);
      }
    }
  }

  private async readOptionalFile(relativePath: string): Promise<string | undefined> {
    const absolutePath = path.join(this.repoPath, relativePath);
    const content = await fs.readFile(absolutePath, "utf8").catch(() => undefined);
    if (content === undefined) {
      return undefined;
    }

    return truncateText(content, this.maxFileChars).text;
  }
}
