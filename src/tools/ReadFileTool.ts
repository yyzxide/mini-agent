import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import { createHash } from "node:crypto";
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
import { estimateTokens } from "../context/TokenEstimator.js";

const ReadFileInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).default(1),
  startColumn: z.number().int().min(1).default(1),
  maxLines: z.number().int().min(1).max(500).default(300),
  maxTokens: z.number().int().min(128).max(4_000).default(3_000),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export interface ReadFileData {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn?: number;
  totalLines: number;
  content: string;
  hasMore: boolean;
  nextStartLine?: number;
  nextStartColumn?: number;
  lineComplete: boolean;
  estimatedTokens: number;
  sourceVersion: string;
}

export class ReadFileTool implements Tool<ReadFileInput, ReadFileData> {
  readonly name = "read_file";
  readonly description = "Read a token-bounded range from a repository text file. Use hasMore with nextStartLine and nextStartColumn to continue until complete when full-file coverage is required.";
  readonly inputSchema = ReadFileInputSchema;
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

    const repoRelativePath = toRepoRelativePath(context.repoPath, fileRealPath);
    if (isInternalRepositoryPath(repoRelativePath)) {
      return toolFailure("INTERNAL_PATH", "Refusing to read internal repository metadata", { path: input.path });
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
    let selectedTokens = 0;
    let tokenBudgetReached = false;
    let partialLine: { line: number; endColumn: number; complete: boolean } | undefined;
    const sourceHash = createHash("sha256");

    const rl = readline.createInterface({
      input: createReadStream(fileRealPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      totalLines += 1;
      sourceHash.update(line);
      sourceHash.update("\n");
      if (
        totalLines >= input.startLine
        && selectedLines.length < input.maxLines
        && !tokenBudgetReached
      ) {
        const isStartingLine = totalLines === input.startLine;
        const startColumn = isStartingLine ? input.startColumn : 1;
        if (startColumn > line.length + 1) {
          return toolFailure("COLUMN_OUT_OF_RANGE", `Column ${String(startColumn)} is outside line ${String(totalLines)}`, {
            path: repoRelativePath,
            line: totalLines,
            column: startColumn,
          });
        }
        const segment = line.slice(startColumn - 1);
        const prefix = selectedLines.length > 0 ? "\n" : "";
        const lineTokens = estimateTokens(`${prefix}${segment}`);
        if (selectedLines.length === 0 && lineTokens > input.maxTokens) {
          const chunk = takeTokenBoundedPrefix(segment, input.maxTokens);
          selectedLines.push(chunk);
          selectedTokens = estimateTokens(chunk);
          partialLine = {
            line: totalLines,
            endColumn: startColumn + chunk.length - 1,
            complete: chunk.length === segment.length,
          };
          tokenBudgetReached = true;
        } else if (selectedTokens + lineTokens > input.maxTokens) {
          tokenBudgetReached = true;
        } else {
          selectedLines.push(segment);
          selectedTokens += lineTokens;
          if (isStartingLine && input.startColumn > 1) {
            partialLine = {
              line: totalLines,
              endColumn: startColumn + segment.length - 1,
              complete: true,
            };
            tokenBudgetReached = true;
          }
        }
      }
    }

    const lineComplete = partialLine?.complete ?? true;
    const endLine = partialLine && !partialLine.complete
      ? input.startLine - 1
      : selectedLines.length === 0
      ? Math.min(input.startLine - 1, totalLines)
      : input.startLine + selectedLines.length - 1;

    const hasMore = !lineComplete || endLine < totalLines;
    return toolSuccess({
      path: repoRelativePath,
      startLine: input.startLine,
      startColumn: input.startColumn,
      endLine,
      ...(partialLine ? { endColumn: partialLine.endColumn } : {}),
      totalLines,
      content: selectedLines.join("\n"),
      hasMore,
      ...(hasMore
        ? lineComplete
          ? { nextStartLine: endLine + 1, nextStartColumn: 1 }
          : { nextStartLine: input.startLine, nextStartColumn: (partialLine?.endColumn ?? 0) + 1 }
        : {}),
      lineComplete,
      estimatedTokens: selectedTokens,
      sourceVersion: `sha256:${sourceHash.digest("hex")}`,
    });
  }
}

function takeTokenBoundedPrefix(value: string, maxTokens: number): string {
  let low = 1;
  let high = value.length;
  let best = value.slice(0, 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function isInternalRepositoryPath(relativePath: string): boolean {
  return relativePath === ".git"
    || relativePath.startsWith(".git/")
    || relativePath === ".mini-agent"
    || relativePath.startsWith(".mini-agent/");
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
