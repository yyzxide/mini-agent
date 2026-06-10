import { execa } from "execa";
import { MiniAgentError } from "../utils/errors.js";
import { normalizeRepoPath, resolveRepoPath, toRepoRelativePath, truncateText } from "../utils/fs.js";

export interface GitManagerOptions {
  repoPath: string;
}

export interface GetDiffOptions {
  cached?: boolean;
  path?: string;
  maxChars?: number;
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
}

export interface GitStatusResult {
  status: string;
}

export interface GitCommitResult {
  commitHash: string;
  message: string;
}

export interface GitDiffSummary {
  changedFiles: string[];
  fileCount: number;
  additions: number;
  deletions: number;
  stat: string;
}

export class GitManager {
  readonly repoPath: string;

  constructor(options: GitManagerOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
  }

  async isGitRepository(): Promise<boolean> {
    try {
      const { stdout } = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.repoPath,
        reject: false,
        encoding: "utf8",
      });
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async getCurrentCommit(): Promise<string | null> {
    const result = await execa("git", ["rev-parse", "HEAD"], {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
    });

    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  async getCurrentBranch(): Promise<string | null> {
    const result = await execa("git", ["branch", "--show-current"], {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
    });

    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  async getStatus(): Promise<string> {
    const result = await execa("git", ["status", "--short"], {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
    });

    return result.stdout;
  }

  async createBranch(branchName: string): Promise<void> {
    this.assertValidBranchName(branchName);
    await this.runGit(["branch", branchName], "Failed to create branch");
  }

  async checkoutBranch(branchName: string): Promise<void> {
    this.assertValidBranchName(branchName);
    await this.runGit(["checkout", branchName], "Failed to checkout branch");
  }

  async addAll(): Promise<void> {
    await this.runGit(["add", "-A"], "Failed to stage changes");
  }

  async commit(message: string): Promise<GitCommitResult> {
    const normalizedMessage = message.trim();
    if (normalizedMessage.length === 0) {
      throw new MiniAgentError("INVALID_COMMIT_MESSAGE", "Commit message cannot be empty");
    }

    if (!(await this.hasChanges())) {
      throw new MiniAgentError("NO_CHANGES_TO_COMMIT", "No changes to commit");
    }

    await this.addAll();
    await this.runGit(["commit", "-m", normalizedMessage], "Failed to commit changes");
    const commitHash = await this.getCurrentCommit();
    if (!commitHash) {
      throw new MiniAgentError("COMMIT_HASH_NOT_FOUND", "Unable to read commit hash after commit");
    }
    return { commitHash, message: normalizedMessage };
  }

  async hasChanges(): Promise<boolean> {
    return (await this.getStatus()).trim().length > 0;
  }

  async getChangedFiles(): Promise<string[]> {
    const result = await this.runGit(["diff", "--name-only"], "Failed to read changed files");
    const unstaged = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    const cached = await this.runGit(["diff", "--cached", "--name-only"], "Failed to read staged changed files");
    const staged = cached.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    return [...new Set([...unstaged, ...staged])].sort();
  }

  async generateDiffSummary(): Promise<GitDiffSummary> {
    const statResult = await this.runGit(["diff", "--shortstat"], "Failed to summarize diff");
    const changedFiles = await this.getChangedFiles();
    const stat = statResult.stdout.trim();
    const fileCount = Number.parseInt(stat.match(/(\d+)\s+files?\s+changed/)?.[1] ?? String(changedFiles.length), 10);
    const additions = Number.parseInt(stat.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? "0", 10);
    const deletions = Number.parseInt(stat.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? "0", 10);

    return {
      changedFiles,
      fileCount: Number.isFinite(fileCount) ? fileCount : changedFiles.length,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      stat,
    };
  }

  async getDiff(options: GetDiffOptions = {}): Promise<GitDiffResult> {
    const args = ["diff"];
    if (options.cached) {
      args.push("--cached");
    }

    if (options.path && options.path.trim().length > 0) {
      const absolutePath = resolveRepoPath(this.repoPath, options.path);
      args.push("--", toRepoRelativePath(this.repoPath, absolutePath));
    }

    const result = await execa("git", args, {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });

    const { text, truncated } = truncateText(result.stdout, options.maxChars ?? 50_000);
    return { diff: text, truncated };
  }

  private async runGit(args: string[], failureMessage: string): Promise<{ stdout: string; stderr: string }> {
    const result = await execa("git", args, {
      cwd: this.repoPath,
      reject: false,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });

    if (result.exitCode !== 0) {
      throw new MiniAgentError("GIT_COMMAND_FAILED", `${failureMessage}: ${result.stderr || result.stdout}`.trim(), {
        args,
        exitCode: result.exitCode,
      });
    }

    return { stdout: result.stdout, stderr: result.stderr };
  }

  private assertValidBranchName(branchName: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(branchName) || branchName.includes("..") || branchName.endsWith("/")) {
      throw new MiniAgentError("INVALID_BRANCH_NAME", `Invalid branch name: ${branchName}`);
    }
  }
}
