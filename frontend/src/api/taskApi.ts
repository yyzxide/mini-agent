import { apiBaseUrl, http } from "./http";
import type { AgentTaskEvent, AgentTaskLog } from "../types/event";
import type { SessionJsonRecord } from "../types/session";
import type {
  AgentTask,
  AgentTaskStatus,
  CreateAgentTaskRequest,
  DiffResponse,
  GitWorkflow,
  PrDraft,
  SandboxInfo,
} from "../types/task";

export interface ListTasksParams {
  status?: AgentTaskStatus;
  repoPath?: string;
}

export async function createTask(input: CreateAgentTaskRequest): Promise<AgentTask> {
  const response = await http.post<AgentTask>("/api/agent/tasks", input);
  return response.data;
}

export async function listTasks(params: ListTasksParams = {}): Promise<AgentTask[]> {
  const response = await http.get<AgentTask[]>("/api/agent/tasks", { params });
  return response.data;
}

export async function getTask(id: number): Promise<AgentTask> {
  const response = await http.get<AgentTask>(`/api/agent/tasks/${id}`);
  return response.data;
}

export async function getTaskEvents(id: number): Promise<AgentTaskEvent[]> {
  const response = await http.get<AgentTaskEvent[]>(`/api/agent/tasks/${id}/events`);
  return response.data;
}

export async function getTaskLogs(id: number): Promise<AgentTaskLog[]> {
  const response = await http.get<AgentTaskLog[]>(`/api/agent/tasks/${id}/logs`);
  return response.data;
}

export async function getTaskDiff(id: number): Promise<string> {
  const response = await http.get<DiffResponse>(`/api/agent/tasks/${id}/diff`);
  return response.data.diff;
}

export async function getTaskSandbox(id: number): Promise<SandboxInfo> {
  const response = await http.get<SandboxInfo>(`/api/agent/tasks/${id}/sandbox`);
  return response.data;
}

export async function getTaskSessionRecords(id: number): Promise<SessionJsonRecord[]> {
  const response = await http.get<SessionJsonRecord[]>(`/api/agent/tasks/${id}/session/records`);
  return response.data;
}

export async function getTaskSessionEvents(id: number, limit?: number): Promise<SessionJsonRecord[]> {
  const response = await http.get<SessionJsonRecord[]>(`/api/agent/tasks/${id}/session/events`, {
    params: { limit },
  });
  return response.data;
}

export async function cancelTask(id: number): Promise<AgentTask> {
  const response = await http.post<AgentTask>(`/api/agent/tasks/${id}/cancel`);
  return response.data;
}

export async function getGitWorkflow(id: number): Promise<GitWorkflow | null> {
  const response = await http.get<GitWorkflow | null>(`/api/agent/tasks/${id}/git/workflow`);
  return response.data;
}

export async function createGitBranch(id: number, branchName?: string): Promise<GitWorkflow> {
  const response = await http.post<GitWorkflow>(`/api/agent/tasks/${id}/git/branch`, { branchName });
  return response.data;
}

export async function commitGitChanges(id: number, commitMessage?: string): Promise<GitWorkflow> {
  const response = await http.post<GitWorkflow>(`/api/agent/tasks/${id}/git/commit`, { commitMessage });
  return response.data;
}

export async function generatePrDraft(id: number, targetBranch?: string): Promise<PrDraft> {
  const response = await http.post<PrDraft>(`/api/agent/tasks/${id}/git/pr-draft`, { targetBranch });
  return response.data;
}

export async function completeGitWorkflow(
  id: number,
  input: { branchName?: string; commitMessage?: string; targetBranch?: string },
): Promise<PrDraft> {
  const response = await http.post<PrDraft>(`/api/agent/tasks/${id}/git/complete`, input);
  return response.data;
}

export function taskEventStreamUrl(id: number): string {
  return `${apiBaseUrl}/api/agent/tasks/${id}/stream`;
}
