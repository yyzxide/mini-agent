import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PathOutsideRepositoryError } from "./errors.js";

export const MINI_AGENT_DIR = ".mini-agent";

export const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  ".corepack",
  "node_modules",
  "target",
  "dist",
  "build",
  ".mini-agent",
]);

export function normalizeRepoPath(repoPath: string): string {
  return path.resolve(repoPath);
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveRepoPath(repoPath: string, targetPath = "."): string {
  if (targetPath.includes("\0")) {
    throw new PathOutsideRepositoryError(targetPath);
  }

  const repoRoot = normalizeRepoPath(repoPath);
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(repoRoot, targetPath);

  if (!isPathInside(repoRoot, resolvedPath)) {
    throw new PathOutsideRepositoryError(targetPath);
  }

  return resolvedPath;
}

export function resolveMiniAgentPath(repoPath: string, ...segments: string[]): string {
  const root = resolveRepoPath(repoPath, MINI_AGENT_DIR);
  const resolvedPath = path.resolve(root, ...segments);

  if (!isPathInside(root, resolvedPath)) {
    throw new PathOutsideRepositoryError(path.join(MINI_AGENT_DIR, ...segments));
  }

  return resolvedPath;
}

export function toRepoRelativePath(repoPath: string, absolutePath: string): string {
  const repoRoot = normalizeRepoPath(repoPath);
  const resolvedPath = path.resolve(absolutePath);

  if (!isPathInside(repoRoot, resolvedPath)) {
    throw new PathOutsideRepositoryError(absolutePath);
  }

  const relativePath = path.relative(repoRoot, resolvedPath);
  return relativePath.length === 0 ? "." : toPosixPath(relativePath);
}

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isIgnoredRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  return parts.some((part) => DEFAULT_IGNORED_NAMES.has(part));
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(directoryPath: string, mode?: number): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  if (mode !== undefined) {
    await fs.chmod(directoryPath, mode);
  }
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  });

  const records: T[] = [];
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      const isTrailingPartialLine = index === lines.length - 1 && !content.endsWith("\n");
      if (isTrailingPartialLine) break;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${message}`);
    }
  }

  return records;
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const content = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (content === undefined) {
    return fallback;
  }

  return JSON.parse(content) as T;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const directoryPath = path.dirname(filePath);
  const tempPath = path.join(directoryPath, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export async function hardenPrivateTree(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.chmod(rootPath, 0o600);
    return;
  }
  await fs.chmod(rootPath, 0o700);
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (entry.isSymbolicLink()) return;
    await hardenPrivateTree(path.join(rootPath, entry.name));
  }));
}

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  const startedAt = Date.now();
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  return {
    text: value.slice(0, Math.max(0, maxChars)),
    truncated: true,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
