import path from "node:path";
import { z } from "zod";
import { pathExists, resolveRepoPath, toRepoRelativePath } from "../utils/fs.js";

export const CodeReviewFindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  certainty: z.enum(["confirmed", "possible"]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  codeQuote: z.string().min(1).max(300),
  reasoning: z.string().min(1),
  suggestedFix: z.string().min(1).optional(),
}).strict();

export const CodeReviewResponseSchema = z.object({
  summary: z.string().min(1),
  overallVerdict: z.enum(["issues_found", "no_confirmed_issues", "needs_more_context"]),
  findings: z.array(CodeReviewFindingSchema).max(12),
  followUp: z.array(z.string().min(1)).max(6).default([]),
}).strict();

export type CodeReviewFinding = z.infer<typeof CodeReviewFindingSchema>;
export type CodeReviewResponse = z.infer<typeof CodeReviewResponseSchema>;

export interface ReviewFileChunk {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface LoadedReviewFile {
  path: string;
  totalLines: number;
  includedEndLine: number;
  truncated: boolean;
  lines: string[];
}

export interface GroundedCodeReviewFinding extends CodeReviewFinding {
  lineText: string;
}

export interface RejectedCodeReviewFinding {
  title: string;
  reason: string;
}

export interface GroundedCodeReviewResult {
  summary: string;
  overallVerdict: "issues_found" | "no_confirmed_issues" | "needs_more_context";
  findings: GroundedCodeReviewFinding[];
  followUp: string[];
  rejectedFindings: RejectedCodeReviewFinding[];
}

export const CodeReviewVerificationItemSchema = z.object({
  index: z.number().int().nonnegative(),
  keep: z.boolean(),
  certainty: z.enum(["confirmed", "possible"]),
  reasoning: z.string().min(1),
  suggestedFix: z.string().min(1).optional(),
  dropReason: z.string().min(1).optional(),
}).strict();

export const CodeReviewVerificationResponseSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(CodeReviewVerificationItemSchema).max(12),
  followUp: z.array(z.string().min(1)).max(6).default([]),
}).strict();

export type CodeReviewVerificationItem = z.infer<typeof CodeReviewVerificationItemSchema>;
export type CodeReviewVerificationResponse = z.infer<typeof CodeReviewVerificationResponseSchema>;

const REVIEWABLE_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".go",
  ".py",
  ".rb",
  ".php",
  ".rs",
  ".kt",
  ".kts",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".md",
  ".sh",
];

const RELATED_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".java",
  ".go",
  ".py",
  ".rb",
  ".php",
  ".rs",
  ".kt",
  ".kts",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
];

const IMPORT_SPECIFIER_PATTERNS = [
  /\bimport\s+[^"'`\n]*?\sfrom\s*["'`]([^"'`]+)["'`]/g,
  /\bexport\s+[^"'`\n]*?\sfrom\s*["'`]([^"'`]+)["'`]/g,
  /\bimport\s*["'`]([^"'`]+)["'`]/g,
  /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /^\s*#include\s+"([^"]+)"/gm,
];

export function looksLikeReviewableFilePath(value: string): boolean {
  const candidate = stripLineSuffix(value.trim());
  if (!candidate || candidate.length > 300) {
    return false;
  }

  const extension = path.extname(candidate).toLowerCase();
  if (!REVIEWABLE_FILE_EXTENSIONS.includes(extension)) {
    return false;
  }

  return /[./\\]/.test(candidate) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(candidate);
}

export function extractLikelyReviewFilePath(text: string): string | undefined {
  const trimmed = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (looksLikeReviewableFilePath(trimmed)) {
    return stripLineSuffix(trimmed);
  }

  const matches = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+(?::\d+)?)/g) ?? [];
  for (const match of matches) {
    const candidate = stripLineSuffix(match);
    if (looksLikeReviewableFilePath(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function buildLoadedReviewFile(chunks: ReviewFileChunk[]): LoadedReviewFile {
  const sorted = [...chunks].sort((left, right) => left.startLine - right.startLine);
  const lines: string[] = [];

  for (const chunk of sorted) {
    const chunkLines = chunk.content.length > 0 ? chunk.content.split("\n") : [];
    lines.push(...chunkLines);
  }

  const lastChunk = sorted.at(-1);
  const totalLines = lastChunk?.totalLines ?? 0;
  const includedEndLine = lastChunk?.endLine ?? 0;

  return {
    path: sorted[0]?.path ?? "",
    totalLines,
    includedEndLine,
    truncated: includedEndLine < totalLines,
    lines,
  };
}

export function formatReviewFileForPrompt(file: LoadedReviewFile): string {
  const header = [
    `File: ${file.path}`,
    `Included lines: 1-${file.includedEndLine} / ${file.totalLines}`,
    `Truncated: ${file.truncated}`,
    "",
  ].join("\n");

  const numberedLines = file.lines
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");

  return `${header}${numberedLines}`;
}

export async function extractRelatedReviewFilePaths(
  repoPath: string,
  file: LoadedReviewFile,
  maxFiles = 3,
): Promise<string[]> {
  if (maxFiles <= 0) {
    return [];
  }

  const specifiers = collectRelatedFileSpecifiers(file.lines.join("\n"));
  const fileDir = path.posix.dirname(normalizePathLike(file.path));
  const primaryPath = normalizePathLike(file.path);
  const seen = new Set<string>([primaryPath]);
  const results: string[] = [];

  for (const specifier of specifiers) {
    const candidates = buildRelatedPathCandidates(fileDir, specifier);

    for (const candidate of candidates) {
      let absolutePath: string;
      try {
        absolutePath = resolveRepoPath(repoPath, candidate);
      } catch {
        continue;
      }

      if (!await pathExists(absolutePath)) {
        continue;
      }

      const relativePath = normalizePathLike(toRepoRelativePath(repoPath, absolutePath));
      if (seen.has(relativePath)) {
        continue;
      }

      seen.add(relativePath);
      results.push(relativePath);
      break;
    }

    if (results.length >= maxFiles) {
      break;
    }
  }

  return results;
}

export function groundCodeReviewResponse(
  response: CodeReviewResponse,
  file: LoadedReviewFile,
): GroundedCodeReviewResult {
  const groundedFindings: GroundedCodeReviewFinding[] = [];
  const rejectedFindings: RejectedCodeReviewFinding[] = [];

  for (const finding of response.findings) {
    const normalizedFile = normalizePathLike(finding.file);
    if (normalizedFile !== file.path && path.basename(normalizedFile) !== path.basename(file.path)) {
      rejectedFindings.push({
        title: finding.title,
        reason: `Finding references a different file: ${finding.file}`,
      });
      continue;
    }

    if (finding.line > file.includedEndLine) {
      rejectedFindings.push({
        title: finding.title,
        reason: `Finding line ${String(finding.line)} is outside the loaded file range 1-${String(file.includedEndLine)}`,
      });
      continue;
    }

    const lineWindow = file.lines
      .slice(Math.max(0, finding.line - 2), Math.min(file.lines.length, finding.line + 1))
      .join("\n");
    if (!normalizedIncludes(lineWindow, finding.codeQuote)) {
      rejectedFindings.push({
        title: finding.title,
        reason: "Finding codeQuote does not match the referenced line window",
      });
      continue;
    }

    groundedFindings.push({
      ...finding,
      file: file.path,
      lineText: file.lines[finding.line - 1] ?? "",
    });
  }

  return {
    summary: groundedFindings.length > 0
      ? response.summary
      : file.truncated && response.overallVerdict === "issues_found"
        ? "No grounded issues were confirmed in the loaded portion of the file. More lines may be needed for a full review."
        : "No grounded issues were confirmed in the reviewed file.",
    overallVerdict: groundedFindings.length > 0 ? response.overallVerdict : file.truncated ? "needs_more_context" : "no_confirmed_issues",
    findings: groundedFindings,
    followUp: response.followUp,
    rejectedFindings,
  };
}

export function applyReviewVerification(
  grounded: GroundedCodeReviewResult,
  verification: CodeReviewVerificationResponse,
): GroundedCodeReviewResult {
  const verifiedFindings: GroundedCodeReviewFinding[] = [];
  const rejectedFindings = [...grounded.rejectedFindings];
  const verificationByIndex = new Map(verification.findings.map((item) => [item.index, item]));

  grounded.findings.forEach((finding, index) => {
    const verified = verificationByIndex.get(index);
    if (!verified) {
      rejectedFindings.push({
        title: finding.title,
        reason: "Verification did not include this finding",
      });
      return;
    }

    if (!verified.keep) {
      rejectedFindings.push({
        title: finding.title,
        reason: verified.dropReason ?? "Verification rejected the finding",
      });
      return;
    }

    verifiedFindings.push({
      ...finding,
      certainty: verified.certainty,
      reasoning: verified.reasoning,
      ...(verified.suggestedFix ? { suggestedFix: verified.suggestedFix } : {}),
    });
  });

  return {
    summary: verifiedFindings.length > 0
      ? verification.summary
      : grounded.overallVerdict === "needs_more_context"
        ? grounded.summary
        : "No verified findings remained after cross-checking the review claims against the file.",
    overallVerdict: verifiedFindings.length > 0 ? "issues_found" : grounded.overallVerdict === "needs_more_context" ? "needs_more_context" : "no_confirmed_issues",
    findings: verifiedFindings,
    followUp: verification.followUp.length > 0 ? verification.followUp : grounded.followUp,
    rejectedFindings,
  };
}

function normalizePathLike(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function collectRelatedFileSpecifiers(content: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = normalizePathLike(match[1] ?? "").trim();
      if (!specifier || seen.has(specifier)) {
        continue;
      }

      if (!isResolvableRelatedSpecifier(specifier)) {
        continue;
      }

      seen.add(specifier);
      results.push(specifier);
    }
  }

  return results;
}

function isResolvableRelatedSpecifier(specifier: string): boolean {
  if (specifier.startsWith("/")) {
    return false;
  }

  if (specifier.startsWith(".")) {
    return true;
  }

  return path.posix.extname(specifier).length > 0 && !specifier.includes(":");
}

function buildRelatedPathCandidates(currentDir: string, specifier: string): string[] {
  const normalizedSpecifier = normalizePathLike(specifier);
  const joined = normalizedSpecifier.startsWith(".")
    ? path.posix.normalize(path.posix.join(currentDir, normalizedSpecifier))
    : path.posix.normalize(path.posix.join(currentDir, normalizedSpecifier));

  const extension = path.posix.extname(joined).toLowerCase();
  const baseWithoutExtension = extension.length > 0 ? joined.slice(0, -extension.length) : joined;

  const candidates = new Set<string>();
  const exactCandidates = extension.length > 0 ? resolveExtensionCandidates(baseWithoutExtension, extension) : [joined];
  for (const candidate of exactCandidates) {
    candidates.add(path.posix.normalize(candidate));
  }

  if (extension.length === 0) {
    candidates.add(joined);
    for (const candidateExtension of RELATED_FILE_EXTENSIONS) {
      candidates.add(`${joined}${candidateExtension}`);
      candidates.add(path.posix.join(joined, `index${candidateExtension}`));
    }
  } else {
    for (const candidateExtension of resolveIndexExtensions(extension)) {
      candidates.add(path.posix.join(baseWithoutExtension, `index${candidateExtension}`));
    }
  }

  return [...candidates];
}

function resolveExtensionCandidates(baseWithoutExtension: string, extension: string): string[] {
  const direct = `${baseWithoutExtension}${extension}`;
  if (extension === ".js") {
    return [
      direct,
      `${baseWithoutExtension}.ts`,
      `${baseWithoutExtension}.tsx`,
      `${baseWithoutExtension}.mts`,
    ];
  }

  if (extension === ".jsx") {
    return [
      direct,
      `${baseWithoutExtension}.tsx`,
      `${baseWithoutExtension}.ts`,
    ];
  }

  if (extension === ".mjs") {
    return [
      direct,
      `${baseWithoutExtension}.mts`,
      `${baseWithoutExtension}.ts`,
    ];
  }

  if (extension === ".cjs") {
    return [
      direct,
      `${baseWithoutExtension}.cts`,
      `${baseWithoutExtension}.ts`,
    ];
  }

  return [direct];
}

function resolveIndexExtensions(extension: string): string[] {
  if (extension === ".js") {
    return [".js", ".ts", ".tsx", ".mts"];
  }

  if (extension === ".jsx") {
    return [".jsx", ".tsx", ".ts"];
  }

  if (extension === ".mjs") {
    return [".mjs", ".mts", ".ts"];
  }

  if (extension === ".cjs") {
    return [".cjs", ".cts", ".ts"];
  }

  return [extension];
}

function normalizedIncludes(container: string, quote: string): boolean {
  const normalizedContainer = normalizeTextForMatch(container);
  const normalizedQuote = normalizeTextForMatch(quote);
  return normalizedQuote.length > 0 && normalizedContainer.includes(normalizedQuote);
}

function normalizeTextForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+$/, "");
}
