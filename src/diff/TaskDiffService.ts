import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { sanitizeChildProcessEnv } from "../command/CommandRunner.js";
import { ensureDir, normalizeRepoPath, resolveMiniAgentPath, truncateText } from "../utils/fs.js";
import type {
  TaskDiffArtifact,
  TaskDiffChangeType,
  TaskDiffFile,
  WorkingTreeSnapshot,
} from "./TaskDiffTypes.js";

export interface TaskDiffServiceOptions {
  repoPath: string;
  maxDiffChars?: number;
}

interface ChangedPath {
  path: string;
  oldPath?: string;
  changeType: TaskDiffChangeType;
}

interface Numstat {
  additions: number;
  deletions: number;
  binary: boolean;
}

export class TaskDiffService {
  private readonly repoPath: string;
  private readonly maxDiffChars: number;

  constructor(options: TaskDiffServiceOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.maxDiffChars = options.maxDiffChars ?? 8 * 1024 * 1024;
  }

  async captureWorkingTree(): Promise<WorkingTreeSnapshot | undefined> {
    if (!(await this.isGitRepository())) {
      return undefined;
    }

    const tempDir = resolveMiniAgentPath(this.repoPath, "tmp");
    await ensureDir(tempDir, 0o700);
    const indexPath = resolveMiniAgentPath(this.repoPath, "tmp", `diff-index-${randomUUID()}`);
    const env = sanitizeChildProcessEnv({ GIT_INDEX_FILE: indexPath });

    try {
      const hasHead = (await this.runGit(["rev-parse", "--verify", "HEAD"])).exitCode === 0;
      const readTree = await execa("git", hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], {
        cwd: this.repoPath,
        env,
        extendEnv: false,
        reject: false,
        encoding: "utf8",
      });
      if (readTree.exitCode !== 0) {
        return undefined;
      }

      const add = await execa("git", [
        "add",
        "-A",
        "--",
        ".",
        ":(exclude).mini-agent",
        ":(exclude).mini-agent/**",
      ], {
        cwd: this.repoPath,
        env,
        extendEnv: false,
        reject: false,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (add.exitCode !== 0) {
        return undefined;
      }

      const tree = await execa("git", ["write-tree"], {
        cwd: this.repoPath,
        env,
        extendEnv: false,
        reject: false,
        encoding: "utf8",
      });
      const treeHash = tree.stdout.trim();
      return tree.exitCode === 0 && treeHash
        ? { treeHash, capturedAt: new Date().toISOString() }
        : undefined;
    } finally {
      await fs.rm(indexPath, { force: true }).catch(() => undefined);
      await fs.rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
    }
  }

  async createArtifact(
    sessionId: string,
    before: WorkingTreeSnapshot,
    after: WorkingTreeSnapshot,
  ): Promise<TaskDiffArtifact> {
    const args = ["diff", "--no-ext-diff", "--find-renames", before.treeHash, after.treeHash, "--"];
    const diffResult = await execa("git", args, {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
      maxBuffer: Math.max(this.maxDiffChars * 2, 16 * 1024 * 1024),
      env: sanitizeChildProcessEnv(undefined),
      extendEnv: false,
    });
    const rawDiff = diffResult.stdout;
    const { text: unifiedDiff, truncated } = truncateText(rawDiff, this.maxDiffChars);
    const [changedPaths, numstats] = await Promise.all([
      this.readChangedPaths(before.treeHash, after.treeHash),
      this.readNumstats(before.treeHash, after.treeHash),
    ]);
    const files = changedPaths.map((changed): TaskDiffFile => {
      const stat = numstats.get(changed.path) ?? { additions: 0, deletions: 0, binary: false };
      return {
        ...changed,
        additions: stat.additions,
        deletions: stat.deletions,
        binary: stat.binary,
      };
    });

    return {
      version: 1,
      artifactId: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      beforeTree: before.treeHash,
      afterTree: after.treeHash,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      files,
      unifiedDiff,
      truncated,
    };
  }

  private async isGitRepository(): Promise<boolean> {
    const result = await this.runGit(["rev-parse", "--is-inside-work-tree"]);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  private async readChangedPaths(beforeTree: string, afterTree: string): Promise<ChangedPath[]> {
    const result = await this.runGit(["diff", "--name-status", "--find-renames", "-z", beforeTree, afterTree, "--"]);
    if (result.exitCode !== 0 || !result.stdout) {
      return [];
    }
    const tokens = result.stdout.split("\0");
    const changed: ChangedPath[] = [];
    let index = 0;
    while (index < tokens.length) {
      const status = tokens[index++] ?? "";
      if (!status) break;
      if (status.startsWith("R") || status.startsWith("C")) {
        const oldPath = tokens[index++] ?? "";
        const filePath = tokens[index++] ?? "";
        if (filePath) {
          changed.push({
            path: filePath,
            ...(oldPath ? { oldPath } : {}),
            changeType: status.startsWith("R") ? "RENAMED" : "COPIED",
          });
        }
        continue;
      }
      const filePath = tokens[index++] ?? "";
      if (filePath) changed.push({ path: filePath, changeType: changeTypeFromStatus(status) });
    }
    return changed;
  }

  private async readNumstats(beforeTree: string, afterTree: string): Promise<Map<string, Numstat>> {
    const result = await this.runGit(["diff", "--numstat", "--find-renames", "-z", beforeTree, afterTree, "--"]);
    const stats = new Map<string, Numstat>();
    if (result.exitCode !== 0 || !result.stdout) {
      return stats;
    }
    const tokens = result.stdout.split("\0");
    let index = 0;
    while (index < tokens.length) {
      const header = tokens[index++] ?? "";
      if (!header) break;
      const [added = "0", deleted = "0", inlinePath = ""] = header.split("\t");
      let filePath = inlinePath;
      if (!filePath) {
        index += 1;
        filePath = tokens[index++] ?? "";
      }
      if (!filePath) continue;
      const binary = added === "-" || deleted === "-";
      stats.set(filePath, {
        additions: binary ? 0 : Number.parseInt(added, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
        binary,
      });
    }
    return stats;
  }

  private async runGit(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await execa("git", args, {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: sanitizeChildProcessEnv(undefined),
      extendEnv: false,
    });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  }
}

function changeTypeFromStatus(status: string): TaskDiffChangeType {
  switch (status[0]) {
    case "A": return "ADDED";
    case "M": return "MODIFIED";
    case "D": return "DELETED";
    case "R": return "RENAMED";
    case "C": return "COPIED";
    default: return "UNKNOWN";
  }
}
