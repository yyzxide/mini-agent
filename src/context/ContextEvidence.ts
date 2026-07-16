import type { AgentDecision } from "../agent/AgentDecision.js";
import type { AgentState } from "../agent/AgentState.js";
import type { TaskPhase } from "./ContextTypes.js";

export function formatRecentEvidence(state: AgentState, phase: TaskPhase): string {
  const decisions = state.decisions.slice(-3).map(formatDecision);
  const toolResults = prioritizeByFailure(state.toolResults.slice(-6), phase)
    .map((result) => [
      `${result.result.success ? "SUCCESS" : "FAILURE"} tool:${result.toolName}`,
      `input: ${safeJson(result.input, 600, "head")}`,
      result.result.success
        ? `result: ${safeJson(result.result.data ?? null, 2_400, result.toolName === "read_file" ? "head_tail" : "head")}`
        : `error: ${result.result.error?.message ?? "unknown tool failure"}`,
    ].join("\n"));
  const commandResults = prioritizeByFailure(state.commandResults.slice(-4), phase)
    .map((result) => [
      `${result.success ? "PASS" : "FAIL"} command:${result.command}`,
      `exitCode: ${String(result.exitCode)}`,
      result.stderr ? `stderr:\n${limitText(result.stderr, 2_000, "tail")}` : "",
      result.stdout ? `stdout:\n${limitText(result.stdout, 1_500, result.success ? "tail" : "head_tail")}` : "",
    ].filter(Boolean).join("\n"));
  const patchResults = prioritizeByFailure(state.patchResults.slice(-3), phase)
    .map((result) => [
      `${result.result.success ? "SUCCESS" : "FAILURE"} patch:${result.description ?? "apply_patch"}`,
      `files: ${extractModifiedFiles(result.patch).join(", ") || "(unknown)"}`,
      ...(!result.result.success ? [`error: ${result.result.error?.message ?? "unknown patch failure"}`] : []),
    ].join("\n"));

  return [
    formatGroup("Recent decisions", decisions),
    formatGroup("Relevant tool evidence", toolResults),
    formatGroup("Recent command evidence", commandResults),
    formatGroup("Recent patch evidence", patchResults),
  ].join("\n\n");
}

function formatDecision(decision: AgentDecision): string {
  switch (decision.type) {
    case "PLAN":
      return `PLAN: ${decision.message}`;
    case "TOOL_CALL":
      return `TOOL_CALL: ${decision.toolName} ${safeJson(decision.input, 500, "head")}`;
    case "DELEGATE_READONLY":
      return `DELEGATE_READONLY: ${decision.reason}; tasks=${decision.tasks.map((task) => task.id).join(", ")}`;
    case "APPLY_PATCH":
      return `APPLY_PATCH: ${decision.description}; files=${extractModifiedFiles(decision.patch).join(", ") || "(unknown)"}`;
    case "RUN_COMMAND":
      return `RUN_COMMAND: ${decision.description}`;
    case "ASK_USER":
      return `ASK_USER: ${decision.message}`;
    case "FINAL":
      return `FINAL success=${String(decision.success)}: ${decision.summary}`;
    case "FAILED":
      return `FAILED: ${decision.error}`;
  }
}

function formatGroup(title: string, values: string[]): string {
  return `${title}:\n${values.length > 0 ? values.join("\n\n") : "(none)"}`;
}

function prioritizeByFailure<T>(values: T[], phase: TaskPhase): T[] {
  if (phase !== "RECOVERY") {
    return values;
  }
  return [...values].sort((left, right) => Number(isSuccessful(left)) - Number(isSuccessful(right)));
}

function isSuccessful(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if ("success" in value && typeof (value as { success?: unknown }).success === "boolean") {
    return (value as { success: boolean }).success;
  }
  if ("result" in value) {
    const result = (value as { result?: unknown }).result;
    return typeof result === "object"
      && result !== null
      && "success" in result
      && (result as { success?: unknown }).success === true;
  }
  return false;
}

function safeJson(value: unknown, maxChars: number, retention: "head" | "tail" | "head_tail"): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  return limitText(serialized, maxChars, retention);
}

function limitText(
  value: string,
  maxChars: number,
  retention: "head" | "tail" | "head_tail",
): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = "\n...[evidence truncated]...\n";
  const budget = Math.max(0, maxChars - marker.length);
  if (retention === "tail") {
    return `${marker.trimStart()}${value.slice(-budget)}`;
  }
  if (retention === "head_tail") {
    const headChars = Math.floor(budget * 0.4);
    return `${value.slice(0, headChars)}${marker}${value.slice(-(budget - headChars))}`;
  }
  return `${value.slice(0, budget)}${marker.trimEnd()}`;
}

function extractModifiedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item) && item !== "/dev/null");
}
