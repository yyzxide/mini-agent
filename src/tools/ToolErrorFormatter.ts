import type { ToolError } from "./Tool.js";

export function formatToolErrorForModel(
  error: ToolError | undefined,
  fallback: string,
): string {
  if (!error) return fallback;
  const details = asRecord(error.details);
  const checkResult = asRecord(details?.checkResult);
  const structured = asRecord(checkResult?.details) ?? details;
  const path = readString(structured?.path);
  const operation = readString(structured?.operation);
  const stderr = readString(checkResult?.stderr) ?? readString(details?.stderr);
  return [
    `${error.code}: ${error.message}`,
    path ? `target=${path}` : undefined,
    operation ? `operation=${operation}` : undefined,
    stderr ? `provider_stderr=${singleLine(stderr, 1_000)}` : undefined,
  ].filter(Boolean).join("; ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function singleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
