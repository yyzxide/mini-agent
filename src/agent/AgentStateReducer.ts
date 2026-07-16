import type { SessionStore } from "../session/SessionStore.js";
import { recoverLatestAgentCheckpoint, type AgentCheckpoint } from "./AgentCheckpoint.js";
import type { AgentOperatingMode } from "./AgentOperatingMode.js";

export class AgentStateReducer {
  constructor(private readonly sessionStore: SessionStore) {}

  async recover(sessionId: string, operatingMode: AgentOperatingMode): Promise<AgentCheckpoint | undefined> {
    const checkpoint = recoverLatestAgentCheckpoint(await this.sessionStore.readRecords(sessionId));
    return checkpoint?.operatingMode === operatingMode ? checkpoint : undefined;
  }
}
