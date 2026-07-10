import { loadAgentConfig, resolveLlmConfig } from "../config/AgentConfig.js";
import { OpenAICompatibleClient } from "../llm/OpenAICompatibleClient.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import type { TaskChangeMode } from "../session/TaskChangeLogStore.js";
import type { JsonObject } from "../session/SessionTypes.js";
import { toJsonObject } from "../utils/json.js";
import type { AgentOperatingMode } from "../agent/AgentOperatingMode.js";

export interface AgentCliOptions {
  session?: string;
  maxSteps?: number;
  model?: string;
  baseUrl?: string;
  eventStream?: boolean;
  agentLoop?: boolean;
  keepSessionActive?: boolean;
  operatingMode?: AgentOperatingMode;
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

export async function openTaskSession(input: {
  repoPath: string;
  userGoal: string;
  options: AgentCliOptions;
  mode?: TaskChangeMode;
  sessionPayload?: JsonObject;
}): Promise<{ sessionId: string; sessionStore: SessionStore; eventStore: EventStore }> {
  const { sessionStore, eventStore } = createStores(input.repoPath, input.options.eventStream === true);
  let sessionId = input.options.session;

  if (sessionId) {
    await sessionStore.ensureSession(sessionId);
    await eventStore.init();
  } else {
    const created = await sessionStore.createSession({ title: input.userGoal.slice(0, 80) });
    sessionId = created.sessionId;
    await eventStore.appendEvent(sessionId, {
      type: "SESSION_CREATED",
      payload: {
        title: created.title,
        repoPath: created.repoPath,
        baseCommit: created.baseCommit,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.sessionPayload ?? {}),
      },
    });
  }

  process.stdout.write(`[session] ${sessionId}\n`);
  return { sessionId, sessionStore, eventStore };
}

export async function recordTaskUserMessage(input: {
  sessionId: string;
  sessionStore: SessionStore;
  eventStore: EventStore;
  content: string;
}): Promise<void> {
  await input.sessionStore.appendRecord(input.sessionId, {
    type: "USER_MESSAGE",
    payload: { content: input.content },
  });
  await input.eventStore.appendEvent(input.sessionId, {
    type: "USER_MESSAGE",
    payload: { content: input.content },
  });
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

export async function recordLlmUsageFromClient(
  sessionStore: SessionStore,
  sessionId: string,
  client: OpenAICompatibleClient,
  mode: string,
): Promise<void> {
  for (const metric of client.drainCallMetrics()) {
    await sessionStore.appendRecord(sessionId, {
      type: "LLM_USAGE",
      payload: toJsonObject({
        mode,
        ...(metric.model ? { model: metric.model } : {}),
        ...(metric.finishReason ? { finishReason: metric.finishReason } : {}),
        usageAvailable: metric.usage !== undefined,
        promptTokens: metric.usage?.promptTokens ?? null,
        completionTokens: metric.usage?.completionTokens ?? null,
        totalTokens: metric.usage?.totalTokens ?? null,
        cachedPromptTokens: metric.usage?.cachedPromptTokens ?? null,
        reasoningTokens: metric.usage?.reasoningTokens ?? null,
      }),
    });
  }
}

function writeStructuredEvent(event: unknown): void {
  process.stdout.write(`MINI_AGENT_EVENT ${JSON.stringify(event)}\n`);
}
