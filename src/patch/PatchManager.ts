import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { GitManager } from "../git/GitManager.js";
import type { GitDiffResult } from "../git/GitManager.js";
import {
  EmptyPatchError,
  InvalidPatchFormatError,
  PatchPathOutsideRepoError,
  PatchTooLargeError,
  PatchTouchesInternalDirectoryError,
} from "../utils/errors.js";
import {
  ensureDir,
  isPathInside,
  normalizeRepoPath,
  resolveMiniAgentPath,
  resolveRepoPath,
  toPosixPath,
  truncateText,
} from "../utils/fs.js";

export interface PatchManagerOptions {
  repoPath: string;
  maxPatchChars?: number;
  maxDiffChars?: number;
}

export interface ValidatePatchInput {
  patch: string;
}

export interface PreviewPatchInput {
  patch: string;
}

export interface ApplyPatchInput {
  patch: string;
  checkBeforeApply?: boolean;
}

export interface GetDiffInput {
  cached?: boolean;
  path?: string;
}

export interface PatchCheckResult {
  success: boolean;
  error?: string;
  stderr?: string;
}

export type PatchChangeType = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "UNKNOWN";

export interface PatchChangedFile {
  path: string;
  changeType: PatchChangeType;
  additions: number;
  deletions: number;
}

export interface PatchPreviewResult {
  files: PatchChangedFile[];
  summary: string;
  truncated: boolean;
}

export interface PatchApplyResult {
  success: boolean;
  applied: boolean;
  checkResult: PatchCheckResult;
  preview: PatchPreviewResult;
  diff: string;
  changedFiles: PatchChangedFile[];
  error?: string;
}

interface MutablePatchFile {
  oldPath: string | undefined;
  newPath: string | undefined;
  displayPath: string | undefined;
  changeType: PatchChangeType;
  additions: number;
  deletions: number;
}

export class PatchManager {
  readonly repoPath: string;
  readonly maxPatchChars: number;
  readonly maxDiffChars: number;

  constructor(options: PatchManagerOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.maxPatchChars = options.maxPatchChars ?? 50_000;
    this.maxDiffChars = options.maxDiffChars ?? 50_000;
  }

  async validatePatch(input: ValidatePatchInput): Promise<PatchCheckResult> {
    try {
      const patch = normalizeUnifiedDiff(input.patch);
      this.assertPatchAllowed(patch);
      const patchFile = await this.writeTempPatch(patch);
      try {
        const result = await execa("git", ["-c", "core.autocrlf=false", "apply", "--check", patchFile], {
          cwd: this.repoPath,
          reject: false,
          encoding: "utf8",
        });

        return result.exitCode === 0
          ? { success: true }
          : {
              success: false,
              error: "git apply --check failed",
              stderr: result.stderr,
            };
      } finally {
        await fs.rm(patchFile, { force: true });
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async previewPatch(input: PreviewPatchInput): Promise<PatchPreviewResult> {
    const patch = normalizeUnifiedDiff(input.patch);
    this.assertPatchAllowed(patch);
    const preview = parseUnifiedDiff(patch);
    const { text, truncated } = truncateText(preview.summary, this.maxPatchChars);
    return {
      files: preview.files,
      summary: text,
      truncated,
    };
  }

  async applyPatch(input: ApplyPatchInput): Promise<PatchApplyResult> {
    const patch = normalizeUnifiedDiff(input.patch);
    const preview = await this.previewPatch({ patch });
    const checkResult = input.checkBeforeApply === false
      ? { success: true }
      : await this.validatePatch({ patch });

    if (!checkResult.success) {
      return {
        success: false,
        applied: false,
        checkResult,
        preview,
        diff: "",
        changedFiles: preview.files,
        error: checkResult.error ?? "Patch check failed",
      };
    }

    const patchFile = await this.writeTempPatch(patch);
    try {
      const result = await execa("git", ["-c", "core.autocrlf=false", "apply", patchFile], {
        cwd: this.repoPath,
        reject: false,
        encoding: "utf8",
      });

      if (result.exitCode !== 0) {
        return {
          success: false,
          applied: false,
          checkResult,
          preview,
          diff: "",
          changedFiles: preview.files,
          error: result.stderr || "git apply failed",
        };
      }

      const diff = await this.getDiff();
      return {
        success: true,
        applied: true,
        checkResult,
        preview,
        diff: diff.diff,
        changedFiles: preview.files,
      };
    } finally {
      await fs.rm(patchFile, { force: true });
    }
  }

  async getDiff(input: GetDiffInput = {}): Promise<GitDiffResult> {
    const git = new GitManager({ repoPath: this.repoPath });
    return await git.getDiff({ ...input, maxChars: this.maxDiffChars });
  }

  private assertPatchAllowed(patch: string): void {
    if (patch.trim().length === 0) {
      throw new EmptyPatchError();
    }

    if (patch.length > this.maxPatchChars) {
      throw new PatchTooLargeError(this.maxPatchChars);
    }

    const paths = extractPatchPaths(patch);
    if (paths.length === 0) {
      throw new InvalidPatchFormatError("Patch does not contain any file paths");
    }

    for (const filePath of paths) {
      assertPatchPathAllowed(this.repoPath, filePath);
    }
  }

  private async writeTempPatch(patch: string): Promise<string> {
    const tmpDir = resolveMiniAgentPath(this.repoPath, "tmp");
    await ensureDir(tmpDir, 0o700);
    const patchFile = resolveMiniAgentPath(this.repoPath, "tmp", `${randomUUID()}.patch`);
    await fs.writeFile(patchFile, patch, "utf8");
    return patchFile;
  }
}

function parseUnifiedDiff(patch: string): PatchPreviewResult {
  const files: MutablePatchFile[] = [];
  let current: MutablePatchFile | undefined;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const nextFile: MutablePatchFile = {
        oldPath: parseDiffGitPath(line, "old"),
        newPath: parseDiffGitPath(line, "new"),
        displayPath: undefined,
        changeType: "MODIFIED",
        additions: 0,
        deletions: 0,
      };
      current = nextFile;
      files.push(current);
      continue;
    }

    if (line.startsWith("rename from ")) {
      if (!current) {
        continue;
      }
      const oldPath = normalizePatchPath(line.slice("rename from ".length));
      if (oldPath) {
        current.oldPath = oldPath;
      }
      current.changeType = "RENAMED";
      continue;
    }

    if (line.startsWith("rename to ")) {
      if (!current) {
        continue;
      }
      const newPath = normalizePatchPath(line.slice("rename to ".length));
      if (newPath) {
        current.newPath = newPath;
        current.displayPath = newPath;
      }
      current.changeType = "RENAMED";
      continue;
    }

    if (line.startsWith("new file mode ")) {
      if (!current) {
        continue;
      }
      current.changeType = "ADDED";
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      if (!current) {
        continue;
      }
      current.changeType = "DELETED";
      continue;
    }

    if (line.startsWith("--- ")) {
      if (!current) {
        current = {
          oldPath: undefined,
          newPath: undefined,
          displayPath: undefined,
          changeType: "MODIFIED",
          additions: 0,
          deletions: 0,
        };
        files.push(current);
      }
      const oldPath = parseHeaderPath(line.slice(4));
      if (oldPath === undefined) {
        current.changeType = "ADDED";
      } else {
        current.oldPath = oldPath;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!current) {
        continue;
      }
      const newPath = parseHeaderPath(line.slice(4));
      if (newPath === undefined) {
        current.changeType = "DELETED";
      } else {
        current.newPath = newPath;
      }
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (!current) {
        continue;
      }
      current.additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      if (!current) {
        continue;
      }
      current.deletions += 1;
    }
  }

  const normalizedFiles = files.map((file) => {
    const path = file.displayPath ?? file.newPath ?? file.oldPath ?? "unknown";
    return {
      path,
      changeType: inferChangeType(file),
      additions: file.additions,
      deletions: file.deletions,
    };
  });

  return {
    files: normalizedFiles,
    summary: summarizePatchFiles(normalizedFiles),
    truncated: false,
  };
}

function normalizeUnifiedDiff(patch: string): string {
  const lines = repairModelStylePatchLines(patch.replace(/\r\n/g, "\n").split("\n"));
  const output = [...lines];
  const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = hunkHeaderPattern.exec(line);
    if (!match) {
      continue;
    }

    let oldCount = 0;
    let newCount = 0;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const hunkLine = lines[cursor] ?? "";

      if (
        hunkHeaderPattern.test(hunkLine)
        || hunkLine.startsWith("diff --git ")
        || hunkLine.startsWith("--- ")
      ) {
        break;
      }

      if (hunkLine.startsWith("\\ No newline at end of file")) {
        continue;
      }

      if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
        newCount += 1;
        continue;
      }

      if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
        oldCount += 1;
        continue;
      }

      if (hunkLine.startsWith(" ")) {
        oldCount += 1;
        newCount += 1;
      }
    }

    const oldStart = match[1] ?? "0";
    const newStart = match[3] ?? "0";
    const suffix = match[5] ?? "";
    output[index] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}`;
  }

  const normalized = output.join("\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function repairModelStylePatchLines(lines: string[]): string[] {
  const repaired = [...lines];
  const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  let currentChangeType: PatchChangeType = "MODIFIED";

  for (let index = 0; index < repaired.length; index += 1) {
    const line = repaired[index] ?? "";

    if (line.startsWith("diff --git ")) {
      currentChangeType = "MODIFIED";
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentChangeType = "ADDED";
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      currentChangeType = "DELETED";
      continue;
    }

    if (line.startsWith("--- ")) {
      const oldPath = parseHeaderPath(line.slice(4));
      if (oldPath === undefined) {
        currentChangeType = "ADDED";
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const newPath = parseHeaderPath(line.slice(4));
      if (newPath === undefined) {
        currentChangeType = "DELETED";
      }
      continue;
    }

    const headerMatch = hunkHeaderPattern.exec(line);
    if (!headerMatch) {
      continue;
    }

    const expectedOld = parseHunkCount(headerMatch[2], headerMatch[1]);
    const expectedNew = parseHunkCount(headerMatch[4], headerMatch[3]);
    let oldSeen = 0;
    let newSeen = 0;
    const bareLineIndexes: number[] = [];

    for (let cursor = index + 1; cursor < repaired.length; cursor += 1) {
      const hunkLine = repaired[cursor] ?? "";

      if (
        hunkHeaderPattern.test(hunkLine)
        || hunkLine.startsWith("diff --git ")
        || hunkLine.startsWith("--- ")
        || hunkLine.startsWith("+++ ")
      ) {
        break;
      }

      if (hunkLine.startsWith("\\ No newline at end of file")) {
        continue;
      }

      if (currentChangeType === "ADDED") {
        if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
          newSeen += 1;
          continue;
        }

        bareLineIndexes.push(cursor);
        continue;
      }

      if (currentChangeType === "DELETED") {
        if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
          oldSeen += 1;
          continue;
        }

        bareLineIndexes.push(cursor);
        continue;
      }

      if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
        newSeen += 1;
        continue;
      }

      if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
        oldSeen += 1;
        continue;
      }

      if (hunkLine.startsWith(" ")) {
        oldSeen += 1;
        newSeen += 1;
        continue;
      }

      bareLineIndexes.push(cursor);
    }

    if (currentChangeType === "ADDED" && newSeen < expectedNew) {
      const deficit = expectedNew - newSeen;
      if (bareLineIndexes.length < deficit) {
        continue;
      }
      for (const cursor of bareLineIndexes.slice(0, deficit)) {
        repaired[cursor] = `+${repaired[cursor] ?? ""}`;
      }
      continue;
    }

    if (currentChangeType === "DELETED" && oldSeen < expectedOld) {
      const deficit = expectedOld - oldSeen;
      if (bareLineIndexes.length < deficit) {
        continue;
      }
      for (const cursor of bareLineIndexes.slice(0, deficit)) {
        repaired[cursor] = `-${repaired[cursor] ?? ""}`;
      }
    }
  }

  return repaired;
}

function parseHunkCount(rawCount: string | undefined, rawStart: string | undefined): number {
  if (rawCount !== undefined) {
    return Number.parseInt(rawCount, 10);
  }

  return rawStart === "0" ? 0 : 1;
}

function inferChangeType(file: MutablePatchFile): PatchChangeType {
  if (file.changeType !== "MODIFIED") {
    return file.changeType;
  }

  if (file.oldPath === undefined && file.newPath) {
    return "ADDED";
  }

  if (file.newPath === undefined && file.oldPath) {
    return "DELETED";
  }

  return "MODIFIED";
}

function summarizePatchFiles(files: PatchChangedFile[]): string {
  if (files.length === 0) {
    return "No files changed";
  }

  const changed = files.map((file) => `${file.path} (+${file.additions}, -${file.deletions})`).join(", ");
  return `${changeVerb(files)} ${files.length} ${files.length === 1 ? "file" : "files"}: ${changed}`;
}

function changeVerb(files: PatchChangedFile[]): string {
  if (files.length === 1) {
    const type = files[0]?.changeType ?? "UNKNOWN";
    return type.charAt(0) + type.slice(1).toLowerCase();
  }

  return "Modified";
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      addPath(paths, parseDiffGitPath(line, "old"));
      addPath(paths, parseDiffGitPath(line, "new"));
    } else if (line.startsWith("--- ")) {
      addPath(paths, parseHeaderPath(line.slice(4)));
    } else if (line.startsWith("+++ ")) {
      addPath(paths, parseHeaderPath(line.slice(4)));
    } else if (line.startsWith("rename from ")) {
      addPath(paths, normalizePatchPath(line.slice("rename from ".length)));
    } else if (line.startsWith("rename to ")) {
      addPath(paths, normalizePatchPath(line.slice("rename to ".length)));
    }
  }

  return [...paths];
}

function addPath(paths: Set<string>, filePath: string | undefined): void {
  if (filePath) {
    paths.add(filePath);
  }
}

function parseDiffGitPath(line: string, side: "old" | "new"): string | undefined {
  const match = /^diff --git\s+(.+?)\s+(.+)$/.exec(line);
  if (!match) {
    return undefined;
  }

  return normalizePatchPath(side === "old" ? match[1] : match[2]);
}

function parseHeaderPath(rawPath: string): string | undefined {
  const trimmed = rawPath.trim().split(/\s+/)[0] ?? "";
  if (trimmed === "/dev/null") {
    return undefined;
  }

  return normalizePatchPath(trimmed);
}

function normalizePatchPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  const unquoted = rawPath.trim().replace(/^"|"$/g, "");
  if (unquoted === "/dev/null") {
    return undefined;
  }

  return toPosixPath(unquoted.replace(/^[ab]\//, ""));
}

function assertPatchPathAllowed(repoPath: string, patchPath: string): void {
  if (patchPath.startsWith("/") || patchPath.includes("\0")) {
    throw new PatchPathOutsideRepoError(patchPath);
  }

  const parts = patchPath.split("/").filter(Boolean);
  if (parts.includes(".git") || parts.includes(".mini-agent")) {
    throw new PatchTouchesInternalDirectoryError(patchPath);
  }

  const resolvedPath = resolveRepoPath(repoPath, patchPath);
  if (!isPathInside(repoPath, resolvedPath)) {
    throw new PatchPathOutsideRepoError(patchPath);
  }
}

export function previewPatchForTesting(patch: string): PatchPreviewResult {
  return parseUnifiedDiff(patch);
}
