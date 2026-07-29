import { loadAgentConfig, resolveLlmConfig } from "../config/AgentConfig.js";
import { OpenAICompatibleClient } from "../llm/OpenAICompatibleClient.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import type { TaskChangeMode } from "../session/TaskChangeLogStore.js";
import type { JsonObject } from "../session/SessionTypes.js";
import type { AgentOperatingMode } from "../agent/AgentOperatingMode.js";

export interface AgentCliOptions {
  session?: string;
  maxSteps?: number;
  model?: string;
  baseUrl?: string;
  eventStream?: boolean;
  verbose?: boolean;
  trace?: boolean;
  keepSessionActive?: boolean;
  operatingMode?: AgentOperatingMode;
  agents?: number;
}

export interface CliTaskResult {
  success: boolean;
  sessionId?: string;
  mode: TaskChangeMode;
  summary: string;
  error?: string;
  metadata?: JsonObject;
}

export function createStores(repoPath: string, eventStream = false): {
  sessionStore: SessionStore;
  eventStore: EventStore;
} {
  return {
    sessionStore: new SessionStore({ repoPath }),
    eventStore: new EventStore({
      repoPath,
      ...(eventStream ? { onEvent: writeStructuredEvent } : {}),
    }),
  };
}

export async function createOpenAICompatibleClient(
  repoPath: string,
  options: AgentCliOptions,
): Promise<OpenAICompatibleClient> {
  const resolvedConfig = resolveLlmConfig(await loadAgentConfig(repoPath), {
    baseUrl: options.baseUrl,
    model: options.model,
  });

  return new OpenAICompatibleClient(resolvedConfig.openai);
}

function writeStructuredEvent(event: unknown): void {
  process.stdout.write(`MINI_AGENT_EVENT ${JSON.stringify(event)}\n`);
}
