import type { AgentDecision } from "../agent/AgentDecision.js";
import type { AgentState } from "../agent/AgentState.js";
import type { WorkingSet } from "./ContextTypes.js";
import { detectTaskPhase } from "./TaskPhaseDetector.js";

const FILE_PATH_PATTERN = /(?:^|[\s`'"(（])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9_-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cpp|cc|c|h|hpp|html|css|md|markdown|json|ya?ml|toml|sh))(?:$|[\s`'",，。)）:：])/g;

export function buildWorkingSet(state: AgentState): WorkingSet {
  const phase = detectTaskPhase(state);
  const recovered = state.recoveredCheckpoint?.workingSet;
  const userMessages = state.messages.filter((message) => message.role === "user").map((message) => message.content);
  const recoveredUnresolvedQuestions = state.recoveredCheckpoint?.status === "WAITING_USER" && userMessages.length > 0
    ? []
    : recovered?.unresolvedQuestions ?? [];
  const hasCurrentActionResult = state.toolResults.length + state.patchResults.length + state.commandResults.length > 0;
  const recoveredFailures = hasCurrentActionResult && state.lastError === null ? [] : recovered?.latestFailures ?? [];
  const goalAndMessages = uniqueStrings([state.userGoal, ...userMessages]);
  const relevantFiles = uniqueStrings([
    ...(recovered?.relevantFiles ?? []),
    ...goalAndMessages.flatMap(extractFilePaths),
    ...state.toolResults.flatMap((result) => extractPathsFromToolResult(result.input, result.result.data)),
    ...state.patchResults.flatMap((result) => extractModifiedFiles(result.patch)),
  ]);
  const modifiedFiles = uniqueStrings(state.patchResults
    .filter((result) => result.result.success)
    .flatMap((result) => extractModifiedFiles(result.patch)));

  return {
    goal: state.userGoal,
    phase,
    constraints: formatStructuredConstraints(state),
    relevantFiles: relevantFiles.slice(-20),
    modifiedFiles: uniqueStrings([...(recovered?.modifiedFiles ?? []), ...modifiedFiles]).slice(-20),
    completedActions: uniqueStrings([
      ...(state.recoveredCheckpoint ? [`checkpoint:resumed ${state.recoveredCheckpoint.runId}`] : []),
      ...(recovered?.completedActions ?? []),
      ...buildCompletedActions(state),
    ]).slice(-12),
    unresolvedQuestions: uniqueStrings([
      ...recoveredUnresolvedQuestions,
      ...state.decisions
        .filter((decision): decision is Extract<AgentDecision, { type: "ASK_USER" }> => decision.type === "ASK_USER")
        .map((decision) => decision.message),
    ]).slice(-5),
    latestFailures: uniqueStrings([...recoveredFailures, ...buildLatestFailures(state)]).slice(-6),
    verificationStatus: uniqueStrings([
      ...(recovered?.verificationStatus ?? []),
      ...state.commandResults.slice(-4).map((result) => (
        `${result.success ? "PASS" : "FAIL"}: ${result.command} (exit ${String(result.exitCode)})`
      )),
    ]).slice(-4),
  };
}

export function formatWorkingSet(workingSet: WorkingSet): string {
  return [
    `Goal: ${workingSet.goal}`,
    `Phase: ${workingSet.phase}`,
    formatList("User constraints", workingSet.constraints),
    formatList("Relevant files", workingSet.relevantFiles),
    formatList("Modified files", workingSet.modifiedFiles),
    formatList("Completed actions", workingSet.completedActions),
    formatList("Unresolved questions", workingSet.unresolvedQuestions),
    formatList("Latest failures", workingSet.latestFailures),
    formatList("Verification status", workingSet.verificationStatus),
  ].join("\n");
}

function extractFilePaths(value: string): string[] {
  return [...value.matchAll(FILE_PATH_PATTERN)].map((match) => match[1]).filter((item): item is string => Boolean(item));
}

function formatStructuredConstraints(state: AgentState): string[] {
  const frame = state.taskContract.taskFrame;
  if (!frame) return [];
  return [
    frame.constraints.readOnly ? "readOnly: repository mutation is prohibited" : undefined,
    frame.constraints.noWeb ? "noWeb: Web access is prohibited" : undefined,
    frame.constraints.noCommands ? "noCommands: command execution is prohibited" : undefined,
    frame.constraints.noDelegation ? "noDelegation: child-agent delegation is prohibited" : undefined,
    frame.constraints.noMcp ? "noMcp: MCP calls are prohibited" : undefined,
    frame.constraints.requireCompleteFileRead
      ? "requireCompleteFileRead: every line of the target file must be read"
      : undefined,
  ].filter((value): value is string => value !== undefined);
}

function extractPathsFromToolResult(input: Record<string, unknown>, data: unknown): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") {
    paths.push(input.path);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return paths;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.path === "string") {
    paths.push(record.path);
  }
  if (Array.isArray(record.results)) {
    for (const result of record.results) {
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        const path = (result as Record<string, unknown>).path;
        if (typeof path === "string") {
          paths.push(path);
        }
      }
    }
  }
  return paths;
}

function extractModifiedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item) && item !== "/dev/null");
}

function buildCompletedActions(state: AgentState): string[] {
  return [
    ...state.toolResults.filter((result) => result.result.success).map((result) => `tool:${result.toolName}`),
    ...state.patchResults.filter((result) => result.result.success).map((result) => `patch:${result.description ?? "applied"}`),
    ...state.commandResults.filter((result) => result.success).map((result) => `command:${result.command}`),
  ];
}

function buildLatestFailures(state: AgentState): string[] {
  return uniqueStrings([
    ...(state.lastError ? [state.lastError] : []),
    ...state.toolResults.filter((result) => !result.result.success)
      .map((result) => result.result.error?.message ?? `${result.toolName} failed`),
    ...state.patchResults.filter((result) => !result.result.success)
      .map((result) => result.result.error?.message ?? "Patch failed"),
    ...state.commandResults.filter((result) => !result.success)
      .map((result) => result.stderr || result.stdout || result.error || `${result.command} failed`),
  ]);
}

function formatList(title: string, values: string[]): string {
  return `${title}: ${values.length > 0 ? values.join(" | ") : "(none)"}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
