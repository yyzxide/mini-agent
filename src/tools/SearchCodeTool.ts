import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

const SearchCodeInputSchema = z.object({
  query: z.string().min(1),
  path: z.string().default("."),
  maxResults: z.number().int().min(1).max(500).default(50),
});

export type SearchCodeInput = z.infer<typeof SearchCodeInputSchema>;

export interface SearchCodeMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchCodeData {
  query: string;
  results: SearchCodeMatch[];
}

interface RgJsonLine {
  type?: string;
  data?: {
    path?: {
      text?: string;
    };
    line_number?: number;
    lines?: {
      text?: string;
    };
  };
}

export class SearchCodeTool implements Tool<SearchCodeInput, SearchCodeData> {
  readonly name = "search_code";
  readonly description = "Search repository code using ripgrep.";
  readonly inputSchema = SearchCodeInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;

  async execute(input: SearchCodeInput, context: ToolContext): Promise<ToolResult<SearchCodeData>> {
    const absolutePath = resolveRepoPath(context.repoPath, input.path);
    const repoRealPath = await fs.realpath(normalizeRepoPath(context.repoPath));
    const targetRealPath = await fs.realpath(absolutePath).catch(() => undefined);

    if (!targetRealPath) {
      return toolFailure("PATH_NOT_FOUND", `Path not found: ${input.path}`);
    }

    if (!isPathInside(repoRealPath, targetRealPath)) {
      return toolFailure("PATH_OUTSIDE_REPOSITORY", "Path is outside repository", { path: input.path });
    }

    const relativePath = toRepoRelativePath(repoRealPath, targetRealPath);

    const args = [
      "--json",
      "--line-number",
      "--color",
      "never",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!target/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!build/**",
      "--glob",
      "!.mini-agent/**",
      "--",
      input.query,
      relativePath,
    ];

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd: context.repoPath,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });

      return toolSuccess({
        query: input.query,
        results: parseRgJson(stdout, input.maxResults),
      });
    } catch (error) {
      if (isCommandNotFound(error)) {
        return toolFailure("RG_NOT_FOUND", "ripgrep (rg) is not installed or not available in PATH");
      }

      if (isNoMatches(error)) {
        return toolSuccess({ query: input.query, results: [] });
      }

      return toolFailure("SEARCH_FAILED", "ripgrep search failed", commandErrorDetails(error));
    }
  }
}

function parseRgJson(stdout: string, maxResults: number): SearchCodeMatch[] {
  const results: SearchCodeMatch[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const parsed = JSON.parse(line) as RgJsonLine;
    if (parsed.type !== "match") {
      continue;
    }

    const filePath = parsed.data?.path?.text;
    const lineNumber = parsed.data?.line_number;
    const text = parsed.data?.lines?.text;

    if (!filePath || typeof lineNumber !== "number" || text === undefined) {
      continue;
    }

    results.push({
      path: normalizeRgPath(filePath),
      line: lineNumber,
      text: text.replace(/\r?\n$/, ""),
    });

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

function normalizeRgPath(filePath: string): string {
  return filePath.replace(/^\.\//, "");
}

function isCommandNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isNoMatches(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 1;
}

function commandErrorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return { error: String(error) };
  }

  return {
    code: "code" in error ? error.code : undefined,
    stdout: "stdout" in error ? error.stdout : undefined,
    stderr: "stderr" in error ? error.stderr : undefined,
  };
}
