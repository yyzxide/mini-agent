export const SUBAGENT_ROLES = [
  "repository_analyst",
  "verification_planner",
  "risk_reviewer",
  "general_researcher",
] as const;

export type SubAgentRole = typeof SUBAGENT_ROLES[number];

export interface SubAgentTask {
  id: string;
  role: SubAgentRole;
  objective: string;
  focusPaths: string[];
}

export type SubAgentStatus =
  | "COMPLETED"
  | "FAILED"
  | "BUDGET_EXHAUSTED"
  | "PROTOCOL_VIOLATION";

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
  enabled: false,
  maxConcurrency: 2,
  maxBatchesPerRun: 1,
  maxTasksPerRun: 3,
  maxChildSteps: 4,
  maxChildLlmCalls: 12,
  maxChildToolCalls: 18,
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
}

export interface SubAgentCoordinator {
  runBatch(input: SubAgentBatchInput): Promise<SubAgentBatchResult>;
}

export function formatSubAgentResults(results: SubAgentResult[]): string {
  return results.map((result) => [
    `Task ${result.taskId} (${result.role}) — ${result.status}`,
    `Objective: ${result.objective}`,
    `Summary: ${result.summary}`,
    `Evidence: ${result.evidence.length > 0
      ? result.evidence.map(formatEvidenceRef).join(" | ")
      : "(none)"}`,
    `Tools: ${result.toolsCalled.length > 0 ? result.toolsCalled.join(", ") : "(none)"}`,
    `Usage: steps=${String(result.usage.steps)}, llmCalls=${String(result.usage.llmCalls)}, toolCalls=${String(result.usage.toolCalls)}`,
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n")).join("\n\n");
}

function formatEvidenceRef(ref: SubAgentEvidenceRef): string {
  if (ref.startLine === undefined) return ref.path;
  return `${ref.path}:${String(ref.startLine)}${ref.endLine !== undefined && ref.endLine !== ref.startLine
    ? `-${String(ref.endLine)}`
    : ""}`;
}
