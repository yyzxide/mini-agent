import type { CommandResult } from "../command/CommandRunner.js";
import type { LongTermMemoryStore } from "../memory/LongTermMemoryStore.js";
import type { TaskChangeLogEntry } from "../session/TaskChangeLogStore.js";
import type { EventRecord, JsonObject, SessionMeta, SessionRecord } from "../session/SessionTypes.js";
import type { LogRecord } from "../utils/logger.js";
import { toJsonObject } from "../utils/json.js";

export interface SessionOverview extends SessionMeta {
  lastUserMessage?: string;
  latestSummary?: string;
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
  });
}

export function isGitDiffData(value: unknown): value is { diff: string } {
  return typeof value === "object"
    && value !== null
    && "diff" in value
    && typeof value.diff === "string";
}

export function formatSessionRecord(record: SessionRecord): string {
  return `[history] ${record.timestamp} ${record.type} ${compactPayload(record.payload, 220)}`;
}

export function formatResumeSessionLine(index: number, session: SessionOverview): string {
  const number = `${String(index).padStart(2, " ")}.`;
  const status = session.status.padEnd(8, " ");
  const updatedAt = formatLocalMinute(session.updatedAt);
  const label = session.lastUserMessage ? "last" : "title";
  const preview = limitSingleLine(session.lastUserMessage ?? session.title, 72);
  const summary = session.latestSummary ? `\n    summary: ${limitSingleLine(session.latestSummary, 88)}` : "";
  return `${number} ${status} ${updatedAt} ${label}: ${preview}\n    id: ${session.sessionId}${summary}`;
}

export function formatInteractiveSessionLine(session: SessionOverview): string {
  const preview = limitSingleLine(session.lastUserMessage ?? session.title, 80);
  const summary = session.latestSummary ? `\n          summary: ${limitSingleLine(session.latestSummary, 96)}` : "";
  return `[session] ${session.sessionId} ${session.status} ${formatLocalMinute(session.updatedAt)} ${preview}${summary}`;
}

export function formatEventRecord(record: EventRecord): string {
  return `[event] ${record.timestamp} ${record.type} ${compactPayload(record.payload, 220)}`;
}

export function formatLogRecord(record: LogRecord): string {
  const session = record.sessionId ? ` session=${record.sessionId}` : "";
  const details = record.details === undefined ? "" : ` ${compactPayload(record.details, 220)}`;
  return `[log] ${record.timestamp} ${record.level.toUpperCase()} ${record.component}${session} ${record.message}${details}`;
}

export function formatTaskChangeLogEntry(entry: TaskChangeLogEntry): string {
  const changedFiles = entry.taskChangedFiles ?? entry.currentChangedFiles;
  const files = changedFiles.length > 0 ? ` files=${changedFiles.slice(0, 8).join(",")}` : "";
  const stat = entry.diffStat ? ` diff="${entry.diffStat}"` : "";
  const tests = entry.tests.length > 0
    ? ` tests=${entry.tests.map((test) => `${test.type}:${test.command}:${String(test.exitCode)}`).join("|")}`
    : "";
  const review = formatReviewChangeMetadata(entry.metadata);
  const web = formatWebChangeMetadata(entry.metadata);
  return `[change] ${entry.timestamp} ${entry.success ? "OK" : "FAIL"} ${entry.mode} session=${entry.sessionId}${files}${stat}${tests}${review}${web} task=${entry.task}`;
}

function formatReviewChangeMetadata(metadata: unknown): string {
  if (!isRecord(metadata) || typeof metadata.reviewFile !== "string") return "";
  const supplementalFileCount = typeof metadata.supplementalFileCount === "number"
    ? metadata.supplementalFileCount
    : undefined;
  const findings = typeof metadata.findings === "number" ? metadata.findings : undefined;
  const rejected = typeof metadata.rejectedFindings === "number" ? metadata.rejectedFindings : undefined;
  const verdict = typeof metadata.overallVerdict === "string" ? metadata.overallVerdict : undefined;
  return [
    ` reviewFile=${metadata.reviewFile}`,
    supplementalFileCount === undefined ? "" : ` related=${String(supplementalFileCount)}`,
    findings === undefined ? "" : ` findings=${String(findings)}`,
    rejected === undefined ? "" : ` rejected=${String(rejected)}`,
    verdict ? ` verdict=${verdict}` : "",
  ].join("");
}

function formatWebChangeMetadata(metadata: unknown): string {
  if (!isRecord(metadata) || !("fetchedSourceCount" in metadata || "sourceCount" in metadata)) return "";
  const sourceCount = typeof metadata.sourceCount === "number" ? metadata.sourceCount : undefined;
  const fetchedSourceCount = typeof metadata.fetchedSourceCount === "number" ? metadata.fetchedSourceCount : undefined;
  return [
    sourceCount === undefined ? "" : ` sources=${String(sourceCount)}`,
    fetchedSourceCount === undefined ? "" : ` fetched=${String(fetchedSourceCount)}`,
  ].join("");
}

export function compactPayload(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

export function readPayloadString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readPayloadNumber(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

export function formatMemoryEntryForOutput(
  entry: Awaited<ReturnType<LongTermMemoryStore["list"]>>[number],
): Omit<typeof entry, "vector"> {
  const { vector: _vector, ...visible } = entry;
  return visible;
}

export function formatLocalMinute(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp;
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function limitSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
