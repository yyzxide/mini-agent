import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import {
  isPathInside,
  normalizeRepoPath,
  resolveRepoPath,
  toRepoRelativePath,
} from "../utils/fs.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const ReadFileInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).default(1),
  maxLines: z.number().int().min(1).max(500).default(300),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export interface ReadFileData {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export class ReadFileTool implements Tool<ReadFileInput, ReadFileData> {
  readonly name = "read_file";
  readonly description = "Read a text file from the repository with line limits.";
  readonly inputSchema = ReadFileInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;

  async execute(input: ReadFileInput, context: ToolContext): Promise<ToolResult<ReadFileData>> {
    const absolutePath = resolveRepoPath(context.repoPath, input.path);
    const repoRealPath = await fs.realpath(normalizeRepoPath(context.repoPath));
    const fileRealPath = await fs.realpath(absolutePath).catch(() => undefined);

    if (!fileRealPath) {
      return toolFailure("FILE_NOT_FOUND", `File not found: ${input.path}`);
    }

    if (!isPathInside(repoRealPath, fileRealPath)) {
      return toolFailure("PATH_OUTSIDE_REPOSITORY", "Path is outside repository", { path: input.path });
    }

    const stat = await fs.stat(fileRealPath);

    if (!stat.isFile()) {
      return toolFailure("PATH_NOT_FILE", `Path is not a file: ${input.path}`);
    }

    if (await isBinaryFile(fileRealPath)) {
      return toolFailure("BINARY_FILE", `Refusing to read binary file: ${input.path}`);
    }

    const selectedLines: string[] = [];
    let totalLines = 0;

    const rl = readline.createInterface({
      input: createReadStream(fileRealPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      totalLines += 1;
      if (totalLines >= input.startLine && selectedLines.length < input.maxLines) {
        selectedLines.push(line);
      }
    }

    const endLine = selectedLines.length === 0
      ? Math.min(input.startLine - 1, totalLines)
      : input.startLine + selectedLines.length - 1;

    return toolSuccess({
      path: toRepoRelativePath(context.repoPath, fileRealPath),
      startLine: input.startLine,
      endLine,
      totalLines,
      content: selectedLines.join("\n"),
    });
  }
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
