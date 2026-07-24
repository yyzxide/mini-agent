export const SUBAGENT_ROLES = [
  "repository_analyst",
  "verification_planner",
  "risk_reviewer",
  "implementation_agent",
  "change_reviewer",
  "general_researcher",
] as const;

export type SubAgentRole = typeof SUBAGENT_ROLES[number];
export type SubAgentAccess = "READ_ONLY" | "PROPOSE_CHANGES" | "REVIEW_CHANGES";

export interface SubAgentTask {
  id: string;
  role: SubAgentRole;
  objective: string;
  focusPaths: string[];
  access: SubAgentAccess;
  dependsOn: string[];
}

export function normalizeSubAgentTask(task: SubAgentTask): SubAgentTask {
  return {
    ...task,
    access: task.access ?? "READ_ONLY",
    dependsOn: task.dependsOn ?? [],
  };
}

export type SubAgentStatus =
  | "COMPLETED"
  | "FAILED"
  | "BUDGET_EXHAUSTED"
  | "PROTOCOL_VIOLATION"
  | "CONFLICT";

export interface SubAgentEvidenceRef {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface SubAgentUsage {
  steps: number;
  llmCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  usageAvailable: boolean;
}

export interface SubAgentResult {
  taskId: string;
  role: SubAgentRole;
  objective: string;
  status: SubAgentStatus;
  summary: string;
  evidence: SubAgentEvidenceRef[];
  toolsCalled: string[];
  usage: SubAgentUsage;
  proposedPatch?: string;
  changedFiles?: string[];
  reviewedTaskIds?: string[];
  baselineFingerprint?: string;
  workspaceKind?: "GIT_WORKTREE" | "ISOLATED_COPY";
  verification?: Array<{
    command: string;
    success: boolean;
    exitCode: number | null;
    durationMs: number;
  }>;
  error?: string;
}

export interface SubAgentBatchResult {
  batchId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  results: SubAgentResult[];
  usage: SubAgentUsage;
  maxParallelAgents: number;
  durationMs: number;
}

export interface MultiAgentPolicy {
  enabled: boolean;
  maxConcurrency: number;
  maxBatchesPerRun: number;
  maxTasksPerRun: number;
  maxChildSteps: number;
  maxChildLlmCalls: number;
  maxChildToolCalls: number;
  maxResultChars: number;
}

export const DEFAULT_MULTI_AGENT_POLICY: MultiAgentPolicy = {
  enabled: true,
  maxConcurrency: 2,
  maxBatchesPerRun: 2,
  maxTasksPerRun: 6,
  maxChildSteps: 8,
  maxChildLlmCalls: 24,
  maxChildToolCalls: 36,
  maxResultChars: 6_000,
};

export interface SubAgentIdentity {
  agentId: string;
  parentRunId: string;
  batchId: string;
  taskId: string;
  role: SubAgentRole;
}

export interface SubAgentBatchInput {
  parentRunId: string;
  originalGoal: string;
  tasks: SubAgentTask[];
  policy: MultiAgentPolicy;
  onProgress?: (event: SubAgentProgressEvent) => void | Promise<void>;
}

export type SubAgentProgressEvent =
  | {
    phase: "task_started";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    dependsOn: string[];
  }
  | {
    phase: "thinking";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    step: number;
  }
  | {
    phase: "worktree_started";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    workspaceKind: "GIT_WORKTREE" | "ISOLATED_COPY";
    baselineFingerprint: string;
  }
  | {
    phase: "decision";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    step: number;
    decisionType: string;
    message: string;
  }
  | {
    phase: "tool_started" | "tool_finished";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    toolName: string;
    success?: boolean;
  }
  | {
    phase: "patch_applied";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    changedFiles: string[];
  }
  | {
    phase: "command_started" | "command_finished";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    command: string;
    success?: boolean;
    exitCode?: number | null;
  }
  | {
    phase: "command_output";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    stream: "stdout" | "stderr";
    message: string;
  }
  | {
    phase: "recovery";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    error: string;
    action: string;
  }
  | {
    phase: "task_finished";
    taskId: string;
    role: SubAgentRole;
    access: SubAgentAccess;
    status: SubAgentStatus;
    changedFiles?: string[];
    toolsCalled: string[];
    error?: string;
  };

export interface SubAgentCoordinator {
  runBatch(input: SubAgentBatchInput): Promise<SubAgentBatchResult>;
}

export function formatSubAgentResults(results: SubAgentResult[]): string {
  return results.map((result) => [
    `Task ${result.taskId} (${result.role}, ${findAccess(result)}) — ${result.status}`,
    `Objective: ${result.objective}`,
    `Summary: ${result.summary}`,
    `Evidence: ${result.evidence.length > 0
      ? result.evidence.map(formatEvidenceRef).join(" | ")
      : "(none)"}`,
    `Tools: ${result.toolsCalled.length > 0 ? result.toolsCalled.join(", ") : "(none)"}`,
    ...(result.proposedPatch ? [
      `Proposed patch (${String(result.proposedPatch.length)} chars):\n${result.proposedPatch}`,
      `Changed files: ${result.changedFiles?.join(", ") || "(unknown)"}`,
    ] : []),
    ...(result.workspaceKind ? [
      `Workspace: ${result.workspaceKind}${result.baselineFingerprint ? ` at baseline ${result.baselineFingerprint}` : ""}`,
    ] : []),
    ...(result.verification?.length ? [
      `Verification: ${result.verification.map((entry) => `${entry.success ? "PASS" : "FAIL"} ${entry.command}`).join(" | ")}`,
    ] : []),
    ...(result.reviewedTaskIds?.length ? [`Reviewed tasks: ${result.reviewedTaskIds.join(", ")}`] : []),
    `Usage: steps=${String(result.usage.steps)}, llmCalls=${String(result.usage.llmCalls)}, toolCalls=${String(result.usage.toolCalls)}`,
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n")).join("\n\n");
}

function findAccess(result: SubAgentResult): SubAgentAccess {
  if (result.proposedPatch) return "PROPOSE_CHANGES";
  if (result.reviewedTaskIds?.length) return "REVIEW_CHANGES";
  return "READ_ONLY";
}

function formatEvidenceRef(ref: SubAgentEvidenceRef): string {
  if (ref.startLine === undefined) return ref.path;
  return `${ref.path}:${String(ref.startLine)}${ref.endLine !== undefined && ref.endLine !== ref.startLine
    ? `-${String(ref.endLine)}`
    : ""}`;
}
