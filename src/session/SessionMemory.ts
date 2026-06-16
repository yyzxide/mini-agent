import type { JsonObject, JsonValue, SessionRecord } from "./SessionTypes.js";
import type { SessionStore } from "./SessionStore.js";

export interface SessionMemoryOptions {
  maxRecords?: number;
  maxChars?: number;
}

const DEFAULT_MAX_RECORDS = 16;
const DEFAULT_MAX_CHARS = 8_000;

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
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const lines = records
    .filter(isUsefulMemoryRecord)
    .slice(-maxRecords)
    .map(formatMemoryRecord)
    .filter((line) => line.length > 0);

  const memory = lines.length > 0 ? lines.join("\n") : "(none)";
  return truncateMiddle(memory, maxChars);
}

function isUsefulMemoryRecord(record: SessionRecord): boolean {
  return [
    "USER_MESSAGE",
    "ASSISTANT_MESSAGE",
    "TASK_SUMMARY",
    "ERROR",
    "TOOL_RESULT",
    "COMMAND_RESULT",
  ].includes(record.type);
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
