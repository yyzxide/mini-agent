export interface AgentTaskEvent {
  id: number;
  taskId: number;
  sessionId?: string;
  eventType: string;
  payload: string | Record<string, unknown> | unknown[];
  createdAt: string;
}

export interface AgentTaskLog {
  id: number;
  taskId: number;
  streamType: "stdout" | "stderr";
  content: string;
  createdAt: string;
}
