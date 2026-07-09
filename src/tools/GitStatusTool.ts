import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const execFileAsync = promisify(execFile);

const GitStatusInputSchema = z.object({}).strict();

export type GitStatusInput = z.infer<typeof GitStatusInputSchema>;

export interface GitStatusData {
  status: string;
}

export class GitStatusTool implements Tool<GitStatusInput, GitStatusData> {
  readonly name = "git_status";
  readonly description = "Show git status --short for the current repository.";
  readonly inputSchema = GitStatusInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;
  readonly metadata = {
    category: "git" as const,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };

  async execute(_input: GitStatusInput, context: ToolContext): Promise<ToolResult<GitStatusData>> {
    if (!(await isGitRepository(context.repoPath))) {
      return toolFailure("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository");
    }

    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: context.repoPath,
      encoding: "utf8",
    });

    return toolSuccess({ status: stdout });
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
