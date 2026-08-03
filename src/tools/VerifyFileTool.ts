import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { VerificationLevel } from "../command/CommandClassification.js";
import { isPathInside, normalizeRepoPath, resolveRepoPath, toRepoRelativePath } from "../utils/fs.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const MAX_VERIFY_FILE_BYTES = 2 * 1024 * 1024;

const VerifyFileInputSchema = z.object({ path: z.string().min(1) });
export type VerifyFileInput = z.infer<typeof VerifyFileInputSchema>;

export interface VerifyFileData {
  path: string;
  level: VerificationLevel;
  repositoryWide: false;
  scopePaths: string[];
  checks: string[];
  scriptCount?: number;
}

/** Read-only, language-aware verification that never executes repository code. */
export class VerifyFileTool implements Tool<VerifyFileInput, VerifyFileData> {
  readonly name = "verify_file";
  readonly description = "Verify one repository file with a compatible built-in parser without executing it. Supports HTML (basic structure plus inline classic JavaScript syntax), JSON, and classic JavaScript (.js/.cjs). Prefer this for standalone HTML instead of `node --check`, which cannot read .html files.";
  readonly inputSchema = VerifyFileInputSchema;
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

  async execute(input: VerifyFileInput, context: ToolContext): Promise<ToolResult<VerifyFileData>> {
    const absolutePath = resolveRepoPath(context.repoPath, input.path);
    const repoRealPath = await fs.realpath(normalizeRepoPath(context.repoPath));
    const fileRealPath = await fs.realpath(absolutePath).catch(() => undefined);
    if (!fileRealPath) return toolFailure("FILE_NOT_FOUND", `File not found: ${input.path}`);
    if (!isPathInside(repoRealPath, fileRealPath)) {
      return toolFailure("PATH_OUTSIDE_REPOSITORY", "Path is outside repository", { path: input.path });
    }
    const stat = await fs.stat(fileRealPath);
    if (!stat.isFile()) return toolFailure("PATH_NOT_FILE", `Path is not a file: ${input.path}`);
    if (stat.size > MAX_VERIFY_FILE_BYTES) {
      return toolFailure("VERIFY_FILE_TOO_LARGE", "File is too large for built-in verification", {
        path: input.path,
        maxBytes: MAX_VERIFY_FILE_BYTES,
        actualBytes: stat.size,
      });
    }

    const relativePath = toRepoRelativePath(context.repoPath, fileRealPath);
    if (relativePath === ".git" || relativePath.startsWith(".git/")
      || relativePath === ".mini-agent" || relativePath.startsWith(".mini-agent/")) {
      return toolFailure("INTERNAL_PATH", "Refusing to verify internal repository metadata", { path: input.path });
    }
    const content = await fs.readFile(fileRealPath, "utf8");
    const extension = path.extname(relativePath).toLowerCase();
    try {
      if (extension === ".html" || extension === ".htm") {
        const html = verifyHtml(content, relativePath);
        return toolSuccess({ path: relativePath, level: "SYNTAX", repositoryWide: false, scopePaths: [relativePath], checks: html.checks, scriptCount: html.scriptCount });
      }
      if (extension === ".json") {
        JSON.parse(content);
        return toolSuccess({ path: relativePath, level: "SYNTAX", repositoryWide: false, scopePaths: [relativePath], checks: ["json-parse"] });
      }
      if (extension === ".js" || extension === ".cjs") {
        new vm.Script(content, { filename: relativePath });
        return toolSuccess({ path: relativePath, level: "SYNTAX", repositoryWide: false, scopePaths: [relativePath], checks: ["classic-javascript-parse"] });
      }
    } catch (error) {
      return toolFailure("FILE_VERIFICATION_FAILED", verificationErrorMessage(error), { path: relativePath, extension });
    }

    return toolFailure("UNSUPPORTED_VERIFY_FILE_TYPE", `No built-in verifier is available for ${extension || "files without an extension"}`, {
      path: relativePath,
      supportedExtensions: [".html", ".htm", ".json", ".js", ".cjs"],
      guidance: "Use the repository's build, lint, typecheck, or test command for this file type.",
    });
  }
}

function verifyHtml(content: string, filename: string): { checks: string[]; scriptCount: number } {
  const openingScripts = content.match(/<script\b/gi)?.length ?? 0;
  const closingScripts = content.match(/<\/script\s*>/gi)?.length ?? 0;
  if (openingScripts !== closingScripts) {
    throw new SyntaxError(`Unbalanced <script> tags: ${String(openingScripts)} opening and ${String(closingScripts)} closing`);
  }
  for (const tag of ["html", "head", "body"]) {
    const opens = content.match(new RegExp(`<${tag}\\b`, "gi"))?.length ?? 0;
    const closes = content.match(new RegExp(`</${tag}\\s*>`, "gi"))?.length ?? 0;
    if (opens !== closes) throw new SyntaxError(`Unbalanced <${tag}> tags: ${String(opens)} opening and ${String(closes)} closing`);
  }

  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let inlineScriptCount = 0;
  for (const match of content.matchAll(scriptPattern)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().toLowerCase();
    if (type === "module") throw new SyntaxError("Inline type=module scripts require a project-aware module verifier");
    if (type && !["text/javascript", "application/javascript"].includes(type)) continue;
    inlineScriptCount += 1;
    new vm.Script(match[2] ?? "", { filename: `${filename}#inline-script-${String(inlineScriptCount)}` });
  }
  return { checks: ["html-structure", "inline-classic-javascript-parse"], scriptCount: inlineScriptCount };
}

function verificationErrorMessage(error: unknown): string {
  return error instanceof Error ? `File verification failed: ${error.message}` : "File verification failed";
}

export function parseVerifyFileData(value: unknown): VerifyFileData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.level !== "SYNTAX" || record.repositoryWide !== false
    || !Array.isArray(record.scopePaths) || !record.scopePaths.every((item) => typeof item === "string")) return undefined;
  return {
    path: record.path,
    level: "SYNTAX",
    repositoryWide: false,
    scopePaths: record.scopePaths as string[],
    checks: Array.isArray(record.checks) ? record.checks.filter((item): item is string => typeof item === "string") : [],
    ...(typeof record.scriptCount === "number" ? { scriptCount: record.scriptCount } : {}),
  };
}
