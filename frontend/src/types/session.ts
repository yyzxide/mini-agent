export type SessionJsonRecord = Record<string, unknown>;

export interface SessionSummary {
  sessionId: string;
  title?: string;
  repoPath?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}
