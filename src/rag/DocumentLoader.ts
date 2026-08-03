import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isIgnoredRelativePath,
  isPathInside,
  normalizeRepoPath,
  resolveRepoPath,
  toRepoRelativePath,
} from "../utils/fs.js";
import type { RagDocument, RagLoadResult, RagSkippedPath } from "./RagTypes.js";

export const RAG_TEXT_EXTENSIONS = [
  ".md", ".markdown", ".txt", ".adoc", ".rst",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".sql", ".graphql", ".gql", ".proto",
  ".html", ".htm", ".css", ".scss", ".xml",
  ".json", ".jsonc", ".yaml", ".yml", ".toml",
] as const;
const SUPPORTED_EXTENSIONS = new Set<string>(RAG_TEXT_EXTENSIONS);
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export class RagDocumentLoader {
  private readonly repoPath: string;
  private readonly maxFileBytes: number;

  constructor(options: { repoPath: string; maxFileBytes?: number }) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async load(inputPaths: string[], tags: string[] = []): Promise<RagLoadResult> {
    if (inputPaths.length === 0) throw new Error("At least one RAG input path is required");
    const repoRealPath = await fs.realpath(this.repoPath);
    const files = new Set<string>();
    const skipped: RagSkippedPath[] = [];

    for (const inputPath of inputPaths) {
      const resolved = resolveRepoPath(this.repoPath, inputPath);
      const realPath = await fs.realpath(resolved).catch(() => undefined);
      if (!realPath) throw new Error(`RAG input path not found: ${inputPath}`);
      if (!isPathInside(repoRealPath, realPath)) throw new Error(`RAG input path is outside repository: ${inputPath}`);
      await this.collectFiles(realPath, files, skipped);
    }

    const normalizedTags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
    const documents: RagDocument[] = [];
    for (const filePath of [...files].sort()) {
      const relativePath = toRepoRelativePath(this.repoPath, filePath);
      const stat = await fs.stat(filePath);
      if (stat.size > this.maxFileBytes) {
        skipped.push({ path: relativePath, reason: "FILE_TOO_LARGE" });
        continue;
      }
      const content = await fs.readFile(filePath);
      if (content.includes(0)) {
        skipped.push({ path: relativePath, reason: "BINARY_CONTENT" });
        continue;
      }
      const text = content.toString("utf8").replace(/\r\n?/g, "\n").trim();
      if (!text) continue;
      const extension = path.extname(relativePath).toLowerCase();
      documents.push({
        source: relativePath,
        title: extractTitle(text, relativePath, extension),
        text,
        sourceHash: hashText(text),
        tags: normalizedTags,
      });
    }

    return { documents, skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)) };
  }

  private async collectFiles(filePath: string, files: Set<string>, skipped: RagSkippedPath[]): Promise<void> {
    const relativePath = toRepoRelativePath(this.repoPath, filePath);
    if (isIgnoredRelativePath(relativePath)) {
      skipped.push({ path: relativePath, reason: "IGNORED_PATH" });
      return;
    }
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        skipped.push({ path: relativePath, reason: "UNSUPPORTED_TYPE" });
        return;
      }
      files.add(filePath);
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      await this.collectFiles(path.join(filePath, entry.name), files, skipped);
    }
  }
}

function extractTitle(text: string, source: string, extension: string): string {
  const heading = extension === ".md" || extension === ".markdown"
    ? text.split("\n").map((line) => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]?.trim()).find(Boolean)
    : undefined;
  return heading ?? path.basename(source, path.extname(source));
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
