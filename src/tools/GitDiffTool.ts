import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import {
  resolveRepoPath,
  toRepoRelativePath,
  truncateText,
} from "../utils/fs.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const execFileAsync = promisify(execFile);

const GitDiffInputSchema = z.object({
  cached: z.boolean().default(false),
  path: z.string().default(""),
});

export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;

export interface GitDiffData {
  diff: string;
  truncated: boolean;
}

export class GitDiffTool implements Tool<GitDiffInput, GitDiffData> {
  readonly name = "git_diff";
  readonly description = "Show git diff for the repository or a single path.";
  readonly inputSchema = GitDiffInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;

  async execute(input: GitDiffInput, context: ToolContext): Promise<ToolResult<GitDiffData>> {
    if (!(await isGitRepository(context.repoPath))) {
      return toolFailure("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository");
    }

    const args = ["diff"];
    if (input.cached) {
      args.push("--cached");
    }

    if (input.path.trim().length > 0) {
      const absolutePath = resolveRepoPath(context.repoPath, input.path);
      args.push("--", toRepoRelativePath(context.repoPath, absolutePath));
    }

    const { stdout } = await execFileAsync("git", args, {
      cwd: context.repoPath,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });

    const maxChars = context.maxOutputChars ?? 20_000;
    const { text, truncated } = truncateText(stdout, maxChars);

    return toolSuccess(
      { diff: text, truncated },
      { truncated, originalLength: stdout.length },
    );
  }
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}
