import type { CommandInput, CommandResult } from "../command/CommandRunner.js";
import type { LlmClient, ToolSpec } from "../llm/LlmClient.js";
import type { LlmCallMetrics } from "../llm/OpenAICompatibleClient.js";
import type { RuntimeLlmUsage } from "../observability/AgentRuntimeEvent.js";
import type { TaskDiffArtifact } from "../diff/TaskDiffTypes.js";
import type { JsonObject } from "../session/SessionTypes.js";
import { toJsonObject, toJsonValue } from "../utils/json.js";
import { redactSecrets } from "../utils/logger.js";
import type { AgentDecision } from "./AgentDecision.js";
import type { AgentState } from "./AgentState.js";

export function aggregateLlmMetrics(metrics: LlmCallMetrics[]): {
  model?: string;
  finishReason?: string;
  usage: RuntimeLlmUsage;
} {
  const usageMetrics = metrics.flatMap((metric) => metric.usage ? [metric.usage] : []);
  const sum = (key: keyof NonNullable<LlmCallMetrics["usage"]>): number | undefined => {
    const values = usageMetrics.map((usage) => usage[key]).filter((value): value is number => value !== undefined);
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const promptTokens = sum("promptTokens");
  const completionTokens = sum("completionTokens");
  const reportedTotal = sum("totalTokens");
  const reasoningTokens = sum("reasoningTokens");
  const cacheReadTokens = sum("cachedPromptTokens");
  const cacheWriteTokens = sum("cacheWriteTokens");
  const lastModel = findLastMetricValue(metrics, "model");
  const lastFinishReason = findLastMetricValue(metrics, "finishReason");
  return {
    ...(lastModel ? { model: lastModel } : {}),
    ...(lastFinishReason ? { finishReason: lastFinishReason } : {}),
    usage: {
      usageAvailable: usageMetrics.length > 0,
      reasoningContentAvailable: metrics.some((metric) => metric.reasoningContentAvailable === true),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(reportedTotal === undefined
        ? promptTokens === undefined || completionTokens === undefined ? {} : { totalTokens: promptTokens + completionTokens }
        : { totalTokens: reportedTotal }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    },
  };
}

function findLastMetricValue(metrics: LlmCallMetrics[], key: "model" | "finishReason"): string | undefined {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const value = metrics[index]?.[key];
    if (value) return value;
  }
  return undefined;
}

export function summarizeToolResult(toolName: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return limitSingleLine(value, 180);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      toolName === "read_file"
      && typeof record.path === "string"
      && record.hasMore === true
      && typeof record.startLine === "number"
      && typeof record.endLine === "number"
      && typeof record.totalLines === "number"
    ) {
      return `${record.path} · partial ${String(record.startLine)}-${String(record.endLine)}/${String(record.totalLines)}`;
    }
    for (const key of ["path", "status", "summary", "message"]) {
      if (typeof record[key] === "string") return limitSingleLine(record[key], 180);
    }
    for (const key of ["results", "files", "matches", "entries"]) {
      if (Array.isArray(record[key])) return `${String(record[key].length)} ${key}`;
    }
    return limitSingleLine(JSON.stringify(value), 180);
  }
  return String(value);
}

export function previewToolResult(value: unknown): string {
  try {
    const serialized = JSON.stringify(redactSecrets(toJsonValue(value)));
    return serialized.length <= 2_000 ? serialized : `${serialized.slice(0, 1_999)}…`;
  } catch {
    return "[unserializable tool result]";
  }
}

export function readEmbeddingCacheStats(value: unknown): {
  memoryHits: number;
  diskHits: number;
  misses: number;
  writes: number;
  coalescedRequests: number;
} | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["memoryHits", "diskHits", "misses", "writes", "coalescedRequests"] as const;
  if (!keys.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) return undefined;
  return {
    memoryHits: record.memoryHits as number,
    diskHits: record.diskHits as number,
    misses: record.misses as number,
    writes: record.writes as number,
    coalescedRequests: record.coalescedRequests as number,
  };
}

function limitSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function drainLlmCallMetrics(client: LlmClient): LlmCallMetrics[] {
  if (typeof (client as { drainCallMetrics?: unknown }).drainCallMetrics === "function") {
    return ((client as unknown as { drainCallMetrics: () => LlmCallMetrics[] }).drainCallMetrics());
  }
  return [];
}

export function commandResultToPayload(result: CommandResult): JsonObject {
  return toJsonObject({
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    success: result.success,
    timedOut: result.timedOut,
    truncated: result.truncated,
    error: result.error,
    verification: result.verification,
  });
}

export function commandInputFromDecision(decision: Extract<AgentDecision, { type: "RUN_COMMAND" }>): CommandInput {
  if (decision.shell) {
    return {
      command: decision.command ?? "",
      shell: true,
      ...(decision.cwd ? { cwd: decision.cwd } : {}),
      ...(decision.timeoutMs === undefined ? {} : { timeoutMs: decision.timeoutMs }),
    };
  }
  return {
    executable: decision.executable ?? "",
    args: decision.args ?? [],
    shell: false,
    ...(decision.cwd ? { cwd: decision.cwd } : {}),
    ...(decision.timeoutMs === undefined ? {} : { timeoutMs: decision.timeoutMs }),
  };
}

export function renderCommandInput(input: CommandInput): string {
  if (input.shell) return input.command ?? "";
  return [input.executable ?? "", ...(input.args ?? [])].map(quoteCommandPart).join(" ").trim();
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function isGitDiffData(value: unknown): value is { diff: string } {
  return typeof value === "object"
    && value !== null
    && "diff" in value
    && typeof value.diff === "string";
}

export function stableDecisionKey(decision: AgentDecision): string {
  return JSON.stringify(sortJsonValue(decision));
}

export function isRedundantSuccessfulWebToolCall(
  state: AgentState,
  toolName: string,
  input: JsonObject,
): boolean {
  if (toolName !== "web_search" && toolName !== "fetch_url") return false;
  const inputKey = JSON.stringify(sortJsonValue(input));
  return state.toolResults.some((result) => (
    result.toolName === toolName
    && result.result.success
    && JSON.stringify(sortJsonValue(result.input)) === inputKey
  ));
}

export function isRedundantSuccessfulIdempotentToolCall(
  state: AgentState,
  tool: ToolSpec | undefined,
  toolName: string,
  input: JsonObject,
): boolean {
  if (
    tool?.annotations?.readOnlyHint !== true
    || tool.annotations.idempotentHint !== true
    || tool.annotations.openWorldHint === true
  ) {
    return false;
  }
  const inputKey = JSON.stringify(sortJsonValue(input));
  if (!state.toolResults.some((result) => (
    result.toolName === toolName
    && result.result.success
    && JSON.stringify(sortJsonValue(result.input)) === inputKey
  ))) {
    return false;
  }
  const currentDecisionIndex = state.decisions.length - 1;
  let previousDecisionIndex = -1;
  for (let index = currentDecisionIndex - 1; index >= 0; index -= 1) {
    const decision = state.decisions[index];
    if (
      decision?.type === "TOOL_CALL"
      && decision.toolName === toolName
      && JSON.stringify(sortJsonValue(decision.input)) === inputKey
    ) {
      previousDecisionIndex = index;
      break;
    }
  }
  if (previousDecisionIndex < 0) return false;
  return !state.decisions
    .slice(previousDecisionIndex + 1, currentDecisionIndex)
    .some((decision) => (
      decision.type === "APPLY_PATCH"
      || decision.type === "APPLY_DELEGATED_PATCH"
      || decision.type === "RUN_COMMAND"
    ));
}

export function isRecoverableLlmProtocolFailure(error: string): boolean {
  return /(?:invalid json|schema validation failed|did not contain a json object|did not include parsable content|response is empty|missing type|agentdecision schema)/i.test(error);
}

export function priorResponseGuardOptions(
  state: AgentState,
  historyTruncated: boolean,
): {
  historyTruncated: boolean;
  auditRequested: boolean;
  semanticQueries: string[];
} {
  const evidence = state.taskContract.taskFrame?.conversationEvidence;
  return {
    historyTruncated,
    auditRequested: evidence?.purpose === "PRIOR_RESPONSE_AUDIT",
    semanticQueries: evidence?.queries ?? [],
  };
}

export function taskDiffRecordMetadata(artifact: TaskDiffArtifact | undefined): Record<string, unknown> {
  if (!artifact) return {};
  return {
    artifactId: artifact.artifactId,
    fileCount: artifact.fileCount,
    additions: artifact.additions,
    deletions: artifact.deletions,
    changedFiles: artifact.files.map((file) => file.path),
    files: artifact.files.map((file) => ({
      path: file.path,
      changeType: file.changeType,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    })),
    truncated: artifact.truncated,
  };
}

export function taskDiffResultMetadata(artifact: TaskDiffArtifact | undefined): {
  diffArtifactId?: string;
  diffFileCount?: number;
  diffAdditions?: number;
  diffDeletions?: number;
} {
  if (!artifact) return {};
  return {
    diffArtifactId: artifact.artifactId,
    diffFileCount: artifact.fileCount,
    diffAdditions: artifact.additions,
    diffDeletions: artifact.deletions,
  };
}

export function collaborationResultMetadata(state: AgentState): {
  delegationBatches?: number;
  subAgents?: number;
} {
  if (state.delegationBatches.length === 0) return {};
  return {
    delegationBatches: state.delegationBatches.length,
    subAgents: state.delegationBatches.reduce((total, batch) => total + batch.results.length, 0),
  };
}

export function hasSuccessfulDelegatedPatchProposal(state: AgentState): boolean {
  return state.delegationBatches.some((batch) => batch.results.some((result) => (
    result.status === "COMPLETED" && typeof result.proposedPatch === "string" && result.proposedPatch.length > 0
  )));
}

export function hasSuccessfulDelegatedReview(state: AgentState, taskId?: string): boolean {
  return state.delegationBatches.some((batch) => batch.results.some((result) => (
    result.status === "COMPLETED"
    && result.reviewedTaskIds !== undefined
    && result.reviewedTaskIds.length > 0
    && (taskId === undefined || result.reviewedTaskIds.includes(taskId))
  )));
}

export function hasAppliedDelegatedPatch(state: AgentState): boolean {
  return state.patchResults.some((result) => (
    result.result.success && /\(delegated by [^)]+\)$/.test(result.description ?? "")
  ));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}
