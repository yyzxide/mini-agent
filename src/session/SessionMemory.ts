import type { JsonObject, JsonValue, SessionRecord } from "./SessionTypes.js";
import type { SessionStore } from "./SessionStore.js";

export interface SessionMemoryOptions {
  maxRecords?: number;
  maxAuxiliaryRecords?: number;
  maxChars?: number;
}

const DEFAULT_MAX_RECORDS = 80;
const DEFAULT_MAX_AUXILIARY_RECORDS = 12;
const DEFAULT_MAX_CHARS = 16_000;

export async function readSessionMemory(
  sessionStore: SessionStore,
  sessionId: string,
  options: SessionMemoryOptions = {},
): Promise<string> {
  const records = await sessionStore.readRecords(sessionId);
  return buildSessionMemory(records, options);
}

export function buildSessionMemory(
  records: SessionRecord[],
  options: SessionMemoryOptions = {},
): string {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxAuxiliaryRecords = options.maxAuxiliaryRecords ?? Math.min(
    DEFAULT_MAX_AUXILIARY_RECORDS,
    Math.max(4, Math.floor(maxRecords * 0.25)),
  );
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const usefulRecords = records.filter((record, index) => {
    return isUsefulMemoryRecord(record) && !isPersistedAgentDecisionMessage(record, records[index - 1]);
  });
  const selectedIds = new Set([
    ...usefulRecords.filter(isPrimaryMemoryRecord).slice(-maxRecords),
    ...usefulRecords.filter(isAuxiliaryMemoryRecord).slice(-maxAuxiliaryRecords),
  ].map((record) => record.id));

  const selectedRecords = usefulRecords.filter((record) => selectedIds.has(record.id));
  const lines = selectedRecords
    .filter((record, index) => !isDuplicateTaskSummary(record, selectedRecords[index - 1]))
    .map(formatMemoryRecord)
    .filter((line) => line.length > 0);

  const memory = lines.length > 0 ? lines.join("\n") : "(none)";
  return truncateMiddle(memory, maxChars);
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

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const headLength = Math.floor(maxChars * 0.6);
  const tailLength = Math.max(0, maxChars - headLength - 40);
  return `${value.slice(0, headLength)}\n...[session memory truncated]...\n${value.slice(-tailLength)}`;
}
