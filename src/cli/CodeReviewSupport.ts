import { formatRuntimeContext } from "../context/RuntimeContext.js";
import {
  buildLoadedReviewFile,
  extractRelatedReviewFilePaths,
  formatReviewFileForPrompt,
} from "../review/CodeReview.js";
import type {
  GroundedCodeReviewFinding,
  GroundedCodeReviewResult,
  LoadedReviewFile,
  ReviewFileChunk,
} from "../review/CodeReview.js";
import type { EventStore } from "../session/EventStore.js";
import type { SessionStore } from "../session/SessionStore.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/Tool.js";

interface ReviewStores {
  sessionId: string;
  sessionStore: SessionStore;
  eventStore: EventStore;
}

export async function loadReviewFile(
  repoPath: string,
  reviewTargetPath: string,
  stores: ReviewStores,
  options?: { maxReviewLines?: number; chunkSize?: number },
): Promise<{ success: true; file: LoadedReviewFile } | { success: false; error: string }> {
  const registry = createDefaultToolRegistry();
  const toolContext: ToolContext = {
    repoPath,
    sessionId: stores.sessionId,
    sessionStore: stores.sessionStore,
    eventStore: stores.eventStore,
    maxOutputChars: 20_000,
    autoApprove: true,
    nonInteractive: true,
  };

  const chunks: ReviewFileChunk[] = [];
  let startLine = 1;
  let loadedLines = 0;
  const maxReviewLines = options?.maxReviewLines ?? 900;
  const chunkSize = options?.chunkSize ?? 220;

  while (loadedLines < maxReviewLines) {
    process.stdout.write("[tool] read_file\n");
    const result = await registry.execute("read_file", {
      path: reviewTargetPath,
      startLine,
      maxLines: chunkSize,
    }, toolContext);

    if (!result.success || !isReadFileData(result.data)) {
      return {
        success: false,
        error: result.error?.message ?? `Failed to read file for review: ${reviewTargetPath}`,
      };
    }

    chunks.push(result.data);
    const linesInChunk = result.data.content.length > 0 ? result.data.content.split("\n").length : 0;
    loadedLines += linesInChunk;

    if (result.data.endLine >= result.data.totalLines || linesInChunk === 0) {
      break;
    }

    startLine = result.data.endLine + 1;
  }

  return { success: true, file: buildLoadedReviewFile(chunks) };
}

export async function loadSupplementalReviewFiles(
  repoPath: string,
  reviewFile: LoadedReviewFile,
  stores: ReviewStores,
): Promise<LoadedReviewFile[]> {
  const relatedPaths = await extractRelatedReviewFilePaths(repoPath, reviewFile, 3);
  const files: LoadedReviewFile[] = [];

  for (const relatedPath of relatedPaths) {
    const result = await loadReviewFile(repoPath, relatedPath, stores, {
      maxReviewLines: 180,
      chunkSize: 180,
    });
    if (result.success) {
      files.push(result.file);
    }
  }

  return files;
}

export function buildCodeReviewContext(input: {
  userGoal: string;
  sessionMemory: string;
  reviewFile: LoadedReviewFile;
  supplementalFiles: LoadedReviewFile[];
}): string {
  return [
    "Review task:", input.userGoal,
    "", "Conversation memory:", input.sessionMemory,
    "", "Runtime context:", formatRuntimeContext(),
    "", "Instructions:",
    "- Review the primary repository file first, and use supplemental related files only as supporting context.",
    "- Report only findings grounded in the provided code.",
    "- Every finding should quote code from the primary file. Use supplemental files only to support or weaken the reasoning.",
    "- If a finding still needs more surrounding code to be proven, mark it as possible instead of confirmed.",
    "- Use the file path exactly as provided in the file sections.",
    "- Keep the findings array short and high-signal.",
    "", "Primary file content:", formatReviewFileForPrompt(input.reviewFile),
    "", "Supplemental related files:",
    ...(input.supplementalFiles.length > 0
      ? input.supplementalFiles.flatMap((file) => ["", formatReviewFileForPrompt(file)])
      : ["(none)"]),
  ].join("\n");
}

export function renderCodeReviewOutput(
  result: GroundedCodeReviewResult,
  file: LoadedReviewFile,
  supplementalFiles: LoadedReviewFile[],
): string {
  const lines = [
    `[review] ${result.summary}`,
    `[review] File: ${file.path} (lines 1-${String(file.includedEndLine)} / ${String(file.totalLines)}${file.truncated ? ", truncated" : ""})`,
  ];

  if (supplementalFiles.length > 0) {
    lines.push(`[review] Supplemental context: ${supplementalFiles.map((item) => item.path).join(", ")}`);
  }

  if (result.findings.length === 0) {
    lines.push("[review] No grounded findings were confirmed in the loaded file content.");
  } else {
    result.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. [${finding.certainty}/${finding.severity}] ${finding.file}:${String(finding.line)} ${finding.title}`);
      lines.push(`Quote: ${finding.codeQuote}`, `Reason: ${finding.reasoning}`);
      if (finding.suggestedFix) lines.push(`Fix: ${finding.suggestedFix}`);
    });
  }

  if (result.rejectedFindings.length > 0) {
    lines.push(`[review] Filtered ${String(result.rejectedFindings.length)} unsupported finding(s) that were not grounded in the file.`);
  }
  if (result.followUp.length > 0) {
    lines.push(`[review] Follow-up: ${result.followUp.join(" | ")}`);
  }

  return lines.join("\n");
}

export function buildCodeReviewVerificationContext(input: {
  userGoal: string;
  reviewFile: LoadedReviewFile;
  supplementalFiles: LoadedReviewFile[];
  findings: GroundedCodeReviewFinding[];
}): string {
  return [
    "Original review request:", input.userGoal,
    "", "Verification instructions:",
    "- Decide whether each preliminary finding is truly supported by the file content.",
    "- The primary file remains the source of truth for each finding quote; use supplemental files only as surrounding context.",
    "- Drop findings whose reasoning is too speculative for the quoted code.",
    "- Keep certainty=confirmed only when the code directly supports the claim.",
    "", "Primary file content:", formatReviewFileForPrompt(input.reviewFile),
    "", "Supplemental related files:",
    ...(input.supplementalFiles.length > 0
      ? input.supplementalFiles.flatMap((file) => ["", formatReviewFileForPrompt(file)])
      : ["(none)"]),
    "", "Preliminary findings JSON:",
    JSON.stringify(input.findings.map((finding, index) => ({
      index,
      severity: finding.severity,
      certainty: finding.certainty,
      file: finding.file,
      line: finding.line,
      title: finding.title,
      codeQuote: finding.codeQuote,
      reasoning: finding.reasoning,
      suggestedFix: finding.suggestedFix,
    })), null, 2),
  ].join("\n");
}

function isReadFileData(value: unknown): value is ReviewFileChunk {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.startLine === "number"
    && typeof value.endLine === "number"
    && typeof value.totalLines === "number"
    && typeof value.content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
