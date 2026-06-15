export type AgentTaskStatus =
  | "CREATED"
  | "STARTING"
  | "RUNNING"
  | "WAITING_REVIEW"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type AgentExecutionMode = "LOCAL" | "DOCKER";

export type SandboxStatus = "CREATED" | "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED" | "REMOVED";

export type GitWorkflowStatus = "CREATED" | "BRANCH_CREATED" | "COMMITTED" | "PR_DRAFT_GENERATED" | "FAILED";

export interface SandboxInfo {
  id: number;
  taskId: number;
  containerId?: string;
  containerName: string;
  image: string;
  workspacePath: string;
  repoWorkspacePath: string;
  status: SandboxStatus;
  cpuLimit?: string;
  memoryLimit?: string;
  networkEnabled: boolean;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
}

export interface AgentTask {
  id: number;
  taskNo: string;
  repoPath: string;
  executionMode: AgentExecutionMode;
  sourceRepoPath?: string;
  workspacePath?: string;
  sandboxId?: number;
  sandboxInfo?: SandboxInfo;
  userGoal: string;
  sessionId?: string;
  status: AgentTaskStatus;
  maxSteps: number;
  runnerPid?: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  finalSummary?: string;
  finalDiff?: string;
}

export interface CreateAgentTaskRequest {
  repoPath: string;
  userGoal: string;
  executionMode: AgentExecutionMode;
  maxSteps: number;
}

export interface GitWorkflow {
  id: number;
  taskId: number;
  repoPath: string;
  workspaceRepoPath?: string;
  baseBranch?: string;
  workBranch?: string;
  baseCommit?: string;
  commitHash?: string;
  commitMessage?: string;
  prTitle?: string;
  prDescription?: string;
  status: GitWorkflowStatus;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export interface PrDraft {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface DiffResponse {
  diff: string;
}
