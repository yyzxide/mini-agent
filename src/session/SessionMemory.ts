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

  return compactSessionLines(lines, maxChars);
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

function compactSessionLines(lines: string[], maxChars: number): string {
  if (lines.length === 0) {
    return "(none)";
  }

  const memory = lines.join("\n");
  if (memory.length <= maxChars) {
    return memory;
  }

  const header = "[structured session compaction]";
  const importantLabel = "Preserved constraints and outcomes:";
  const recentLabel = "Recent records:";
  const fixedChars = header.length + importantLabel.length + recentLabel.length + 4;
  const available = Math.max(0, maxChars - fixedChars);
  const importantCandidates = lines.filter((line) => (
    /^\[(?:summary|error|memory)\]/i.test(line)
    || (/^\[user\]/i.test(line) && /(?:不要|不得|不能|必须|只能|保持|避免|do not|don't|must|only|keep|avoid)/i.test(line))
  ));
  const important = takeRecentLines(importantCandidates, Math.floor(available * 0.35));
  const importantText = important.length > 0 ? important.join("\n") : "(none extracted)";
  const recentBudget = Math.max(0, available - importantText.length);
  const importantSet = new Set(important);
  const recent = takeRecentLines(lines.filter((line) => !importantSet.has(line)), recentBudget);
  const recentText = recent.length > 0 ? recent.join("\n") : "(none)";

  return [header, importantLabel, importantText, recentLabel, recentText].join("\n").slice(0, maxChars);
}

function takeRecentLines(lines: string[], maxChars: number): string[] {
  if (maxChars <= 0) {
    return [];
  }
  const selected: string[] = [];
  let remaining = maxChars;
  for (const line of [...lines].reverse()) {
    const separatorChars = selected.length > 0 ? 1 : 0;
    if (line.length + separatorChars <= remaining) {
      selected.unshift(line);
      remaining -= line.length + separatorChars;
      continue;
    }
    if (selected.length === 0 && remaining >= 40) {
      const marker = " ...[record compacted]... ";
      const contentBudget = Math.max(0, remaining - marker.length);
      const headChars = Math.floor(contentBudget * 0.35);
      selected.unshift(`${line.slice(0, headChars)}${marker}${line.slice(-(contentBudget - headChars))}`);
    }
    break;
  }
  return selected;
}
