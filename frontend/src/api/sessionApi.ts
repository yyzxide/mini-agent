import { http } from "./http";
import type { SessionJsonRecord, SessionSummary } from "../types/session";

export async function listSessions(repoPath: string): Promise<SessionSummary[]> {
  const response = await http.get<SessionSummary[]>("/api/sessions", { params: { repoPath } });
  return response.data;
}

export async function getSessionRecords(repoPath: string, sessionId: string): Promise<SessionJsonRecord[]> {
  const response = await http.get<SessionJsonRecord[]>(`/api/sessions/${sessionId}/records`, {
    params: { repoPath },
  });
  return response.data;
}

export async function getSessionEvents(repoPath: string, sessionId: string, limit?: number): Promise<SessionJsonRecord[]> {
  const response = await http.get<SessionJsonRecord[]>(`/api/sessions/${sessionId}/events`, {
    params: { repoPath, limit },
  });
  return response.data;
}
