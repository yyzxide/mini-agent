import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import {
  isPathInside,
  isIgnoredRelativePath,
  normalizeRepoPath,
  resolveRepoPath,
  toRepoRelativePath,
} from "../utils/fs.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const ListFilesInputSchema = z.object({
  path: z.string().default("."),
  maxDepth: z.number().int().min(0).max(20).default(2),
  maxResults: z.number().int().min(1).max(1000).default(200),
});

export type ListFilesInput = z.infer<typeof ListFilesInputSchema>;

export interface ListFilesItem {
  path: string;
  type: "file" | "directory";
}

export interface ListFilesData {
  items: ListFilesItem[];
}

export class ListFilesTool implements Tool<ListFilesInput, ListFilesData> {
  readonly name = "list_files";
  readonly description = "List files and directories under a repository path.";
  readonly inputSchema = ListFilesInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;
  readonly metadata = {
    category: "filesystem" as const,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };

  async execute(input: ListFilesInput, context: ToolContext): Promise<ToolResult<ListFilesData>> {
    const targetPath = resolveRepoPath(context.repoPath, input.path);
    const repoRealPath = await fs.realpath(normalizeRepoPath(context.repoPath));
    const targetRealPath = await fs.realpath(targetPath).catch(() => undefined);

    if (!targetRealPath) {
      return toolFailure("PATH_NOT_FOUND", `Path not found: ${input.path}`);
    }

    if (!isPathInside(repoRealPath, targetRealPath)) {
      return toolFailure("PATH_OUTSIDE_REPOSITORY", "Path is outside repository", { path: input.path });
    }

    const targetStat = await fs.stat(targetRealPath);

    if (!targetStat.isDirectory()) {
      return toolFailure("PATH_NOT_DIRECTORY", `Path is not a directory: ${input.path}`);
    }

    const items: ListFilesItem[] = [];
    let truncated = false;

    const walk = async (directoryPath: string, depth: number): Promise<void> => {
      if (items.length >= input.maxResults) {
        truncated = true;
        return;
      }

      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (items.length >= input.maxResults) {
          truncated = true;
          return;
        }

        const absolutePath = path.join(directoryPath, entry.name);
        if (!isPathInside(repoRealPath, absolutePath)) {
          continue;
        }

        const relativePath = toRepoRelativePath(repoRealPath, absolutePath);

        if (isIgnoredRelativePath(relativePath)) {
          continue;
        }

        const type = entry.isDirectory() ? "directory" : "file";
        items.push({ path: relativePath, type });

        if (entry.isDirectory() && depth < input.maxDepth) {
          await walk(absolutePath, depth + 1);
        }
      }
    };

    await walk(targetRealPath, 0);

    return toolSuccess({ items }, { truncated, count: items.length });
  }
}
