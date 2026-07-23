import type { JsonObject, JsonValue, SessionRecord } from "./SessionTypes.js";
import type { SessionStore } from "./SessionStore.js";
import { estimateTokens } from "../context/TokenEstimator.js";
import {
  compactStructuredItems,
  type CompactionBucket,
  type StructuredCompactionSelection,
} from "../context/StructuredCompactor.js";

export interface SessionMemoryOptions {
  maxRecords?: number;
  maxAuxiliaryRecords?: number;
  maxChars?: number;
  maxTokens?: number;
  excludeRunId?: string;
}

export interface SessionMemoryTrace {
  totalRecords: number;
  usefulRecords: number;
  selectedRecords: number;
  inputChars: number;
  outputChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  compacted: boolean;
  excludedCurrentRunRecords: number;
  strategy: "passthrough" | "structured-salience-v2";
  candidateRecords: number;
  droppedRecords: number;
  clippedRecords: number;
  pinnedRecords: number;
  selections: StructuredCompactionSelection[];
}

export interface SessionMemoryBuildResult {
  memory: string;
  trace: SessionMemoryTrace;
}

const DEFAULT_MAX_RECORDS = 80;
const DEFAULT_MAX_AUXILIARY_RECORDS = 12;
const DEFAULT_MAX_CHARS = 16_000;

export async function readSessionMemory(
  sessionStore: SessionStore,
  sessionId: string,
  options: SessionMemoryOptions = {},
): Promise<string> {
  return (await readSessionMemoryWithTrace(sessionStore, sessionId, options)).memory;
}

export async function readSessionMemoryWithTrace(
  sessionStore: SessionStore,
  sessionId: string,
  options: SessionMemoryOptions = {},
): Promise<SessionMemoryBuildResult> {
  const records = await sessionStore.readRecords(sessionId);
  return buildSessionMemoryWithTrace(records, options);
}

export function buildSessionMemory(
  records: SessionRecord[],
  options: SessionMemoryOptions = {},
): string {
  return buildSessionMemoryWithTrace(records, options).memory;
}

export function buildSessionMemoryWithTrace(
  records: SessionRecord[],
  options: SessionMemoryOptions = {},
): SessionMemoryBuildResult {
  const currentRunStart = options.excludeRunId
    ? records.findIndex((record) => record.payload.runId === options.excludeRunId)
    : -1;
  const scopedRecords = currentRunStart >= 0 ? records.slice(0, currentRunStart) : records;
  const excludedCurrentRunRecords = records.length - scopedRecords.length;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxAuxiliaryRecords = options.maxAuxiliaryRecords ?? Math.min(
    DEFAULT_MAX_AUXILIARY_RECORDS,
    Math.max(4, Math.floor(maxRecords * 0.25)),
  );
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxTokens = options.maxTokens ?? Math.max(128, Math.floor(maxChars / 4));
  const usefulRecords = scopedRecords.filter((record, index) => {
    return isUsefulMemoryRecord(record) && !isPersistedAgentDecisionMessage(record, scopedRecords[index - 1]);
  });
  const selectedIds = new Set([
    ...usefulRecords.filter(isPrimaryMemoryRecord).slice(-maxRecords),
    ...usefulRecords.filter(isAuxiliaryMemoryRecord).slice(-maxAuxiliaryRecords),
  ].map((record) => record.id));

  const candidateRecords = usefulRecords.filter((record) => selectedIds.has(record.id));
  const selectedRecords = candidateRecords
    .filter((record, index, values) => !isDuplicateTaskSummary(record, values[index - 1]));
  const lines = selectedRecords.map(formatMemoryRecord).filter((line) => line.length > 0);
  const uncompressed = lines.length > 0 ? lines.join("\n") : "(none)";
  const requiresCompaction = uncompressed.length > maxChars
    || estimateTokens(uncompressed) > maxTokens;
  const compaction = requiresCompaction
    ? compactStructuredItems(
      selectedRecords.map((record, index) => toCompactionItem(record, index, selectedRecords.length)),
      { maxChars, maxTokens },
    )
    : undefined;
  const memory = compaction?.text ?? uncompressed;
  return {
    memory,
    trace: {
      totalRecords: scopedRecords.length,
      usefulRecords: usefulRecords.length,
      selectedRecords: compaction?.trace.selectedItems ?? selectedRecords.length,
      inputChars: uncompressed.length,
      outputChars: memory.length,
      estimatedInputTokens: estimateTokens(uncompressed),
      estimatedOutputTokens: estimateTokens(memory),
      compacted: requiresCompaction,
      excludedCurrentRunRecords,
      strategy: compaction?.trace.strategy ?? "passthrough",
      candidateRecords: selectedRecords.length,
      droppedRecords: compaction?.trace.droppedItems ?? 0,
      clippedRecords: compaction?.trace.clippedItems ?? 0,
      pinnedRecords: compaction?.trace.pinnedItems ?? 0,
      selections: compaction?.trace.selections ?? [],
    },
  };
}

function toCompactionItem(record: SessionRecord, index: number, total: number) {
  const bucket = memoryBucket(record);
  const recencyBoost = total > 0 ? Math.round((index / total) * 12) : 0;
  const { priority, reason } = memoryPriority(record);
  return {
    sourceId: record.id.slice(0, 8),
    content: formatMemoryRecord(record),
    bucket,
    priority: priority + recencyBoost,
    reason,
    order: index,
  };
}

function memoryBucket(record: SessionRecord): CompactionBucket {
  if (
    record.type === "TASK_SUMMARY"
    || record.type === "ERROR"
    || record.type === "MEMORY_COMPACTION"
    || (record.type === "USER_MESSAGE" && hasExplicitConstraint(record))
  ) {
    return "PINNED";
  }
  if (record.type === "USER_MESSAGE" || record.type === "ASSISTANT_MESSAGE") {
    return "CONVERSATION";
  }
  return "EVIDENCE";
}

function memoryPriority(record: SessionRecord): { priority: number; reason: string } {
  switch (record.type) {
    case "ERROR":
      return { priority: 100, reason: "unresolved or historical error evidence" };
    case "TASK_SUMMARY":
      return { priority: 96, reason: "completed task outcome" };
    case "MEMORY_COMPACTION":
      return { priority: 94, reason: "previously preserved memory facts" };
    case "USER_MESSAGE":
      return hasExplicitConstraint(record)
        ? { priority: 92, reason: "explicit user constraint" }
        : { priority: 76, reason: "recent user request" };
    case "ASSISTANT_MESSAGE":
      return { priority: 68, reason: "recent assistant response" };
    case "COMMAND_RESULT":
      return { priority: 58, reason: "command or verification evidence" };
    case "TOOL_RESULT":
      return { priority: 52, reason: "tool evidence" };
    default:
      return { priority: 40, reason: "session evidence" };
  }
}

function hasExplicitConstraint(record: SessionRecord): boolean {
  return /(?:不要|不得|不能|必须|只能|需要|应该|希望|倾向|优先|保持|避免|禁止|do not|don't|must|only|need|should|prefer|keep|avoid)/i
    .test(payloadString(record.payload, "content"));
}

function isDuplicateTaskSummary(record: SessionRecord, previous: SessionRecord | undefined): boolean {
  if (record.type !== "TASK_SUMMARY" || previous?.type !== "ASSISTANT_MESSAGE") {
    return false;
  }

  const summary = payloadString(record.payload, "summary");
  const previousAnswer = payloadString(previous.payload, "content");
  return summary.length > 0 && summary === previousAnswer;
}

function isPrimaryMemoryRecord(record: SessionRecord): boolean {
  return [
    "USER_MESSAGE",
    "ASSISTANT_MESSAGE",
    "TASK_SUMMARY",
    "ERROR",
    "MEMORY_COMPACTION",
  ].includes(record.type);
}

function isAuxiliaryMemoryRecord(record: SessionRecord): boolean {
  return [
    "TOOL_RESULT",
    "COMMAND_RESULT",
  ].includes(record.type);
}

function isUsefulMemoryRecord(record: SessionRecord): boolean {
  return isPrimaryMemoryRecord(record) || isAuxiliaryMemoryRecord(record);
}

function isPersistedAgentDecisionMessage(
  record: SessionRecord,
  previousRecord: SessionRecord | undefined,
): boolean {
  return record.type === "ASSISTANT_MESSAGE" && previousRecord?.type === "AGENT_DECISION";
}

function formatMemoryRecord(record: SessionRecord): string {
  switch (record.type) {
    case "USER_MESSAGE":
      return `[user] ${payloadString(record.payload, "content")}`;
    case "ASSISTANT_MESSAGE":
      return `[assistant] ${payloadString(record.payload, "content")}`;
    case "TASK_SUMMARY":
      return `[summary] ${payloadString(record.payload, "summary")}`;
    case "ERROR":
      return `[error] ${payloadString(record.payload, "message", "error")}`;
    case "TOOL_RESULT":
      return `[tool] ${payloadString(record.payload, "toolName", "name")} ${compactJson(record.payload)}`;
    case "COMMAND_RESULT":
      return `[command] ${payloadString(record.payload, "command")} ${compactJson(record.payload)}`;
    case "MEMORY_COMPACTION":
      return `[memory] ${payloadString(record.payload, "summary")}`;
    default:
      return "";
  }
}

function payloadString(payload: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return compactJson(payload);
}

function compactJson(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
