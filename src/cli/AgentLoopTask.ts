import { AgentLoop } from "../agent/AgentLoop.js";
import { CommandRunner } from "../command/CommandRunner.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createConfiguredToolRegistry } from "../mcp/McpRegistryLoader.js";
import { createOpenAICompatibleClient, createStores } from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";
import { IsolatedSubAgentCoordinator } from "../agent/IsolatedSubAgentCoordinator.js";
import { loadAgentConfig, resolveMultiAgentPolicy } from "../config/AgentConfig.js";
import type { AgentTaskContract } from "../agent/AgentTaskContract.js";
import { createDefaultAgentTaskContract } from "../agent/AgentTaskContract.js";
import {
  buildConversationHistoryWithTrace,
  estimateConversationTokens,
  focusConversationHistory,
} from "../session/ConversationHistory.js";
import { toJsonObject, toJsonValue } from "../utils/json.js";
import { TerminalRenderer } from "../observability/TerminalRenderer.js";
import { sanitizeTerminalText } from "../observability/TerminalSanitizer.js";
import type { AgentRuntimeEvent, RuntimeVerbosity } from "../observability/AgentRuntimeEvent.js";
import { redactSecrets } from "../utils/logger.js";

export async function runAgentLoopTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions & { nonInteractive?: boolean },
  prompt?: (message: string) => Promise<string>,
  taskContract: AgentTaskContract = createDefaultAgentTaskContract(),
): Promise<CliTaskResult> {
  const { sessionStore, eventStore } = createStores(repoPath);
  const recordsBeforeCurrent = options.session
    ? await sessionStore.readRecords(options.session).catch(() => [])
    : [];
  // Build a broad retrieval pool first, then let the conversation planner fit
  // the selected evidence into the actual prompt budget. The records are
  // already resident in memory, so searching the complete conversational
  // record avoids making older disputed assistant claims unreachable.
  const conversationHistory = buildConversationHistoryWithTrace(recordsBeforeCurrent, {
    maxMessages: Number.MAX_SAFE_INTEGER,
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  // Give TaskFrame a neutral recent window. It can request older evidence
  // through conversationEvidence after semantic resolution.
  const conversationFocus = focusConversationHistory(
    conversationHistory.messages,
    {
      maxMessages: 16,
      maxChars: 12_000,
    },
  );
  const effectiveContract: AgentTaskContract = {
    ...taskContract,
  };
  const verbosity: RuntimeVerbosity = options.trace === true
    ? "trace"
    : options.verbose === true ? "verbose" : "normal";
  const renderer = new TerminalRenderer({ contract: effectiveContract, verbosity });
  const onRuntimeEvent = (event: AgentRuntimeEvent): void => {
    renderer.render(event);
    if (options.eventStream === true) {
      process.stdout.write(`MINI_AGENT_EVENT ${JSON.stringify(redactSecrets(toJsonValue(event)))}\n`);
    }
  };
  const permissionManager = new PermissionManager(prompt ? { prompt } : {});
  const multiAgent = resolveMultiAgentPolicy(
    await loadAgentConfig(repoPath),
    options.agents,
  );
  const llmClient = await createOpenAICompatibleClient(repoPath, options);
  const { registry: toolRegistry, diagnostics } = await createConfiguredToolRegistry(repoPath);
  for (const diagnostic of diagnostics.filter((entry) => !entry.success)) {
    const safeServer = sanitizeTerminalText(diagnostic.server);
    const safeError = sanitizeTerminalText(String(redactSecrets(diagnostic.error ?? "failed to load")));
    process.stderr.write(`[mcp] ${safeServer}: ${safeError}\n`);
  }
  const loop = new AgentLoop({
    repoPath,
    llmClient,
    toolRegistry,
    sessionStore,
    eventStore,
    commandRunner: new CommandRunner({ repoPath }),
    permissionManager,
    patchManager: new PatchManager({ repoPath }),
    contextBuilder: new ContextBuilder({ repoPath }),
    onProgress: onRuntimeEvent,
    ...(prompt ? { askUser: prompt } : {}),
    ...(multiAgent.enabled
      ? {
        subAgentCoordinator: new IsolatedSubAgentCoordinator({
          repoPath,
          createLlmClient: async () => await createOpenAICompatibleClient(repoPath, options),
        }),
      }
      : {}),
  });

  const result = await loop.run({
    userGoal,
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    autoApprove: true,
    nonInteractive: options.nonInteractive === true,
    keepSessionActive: options.keepSessionActive === true,
    operatingMode: options.operatingMode ?? "EXECUTE",
    multiAgent,
    taskContract: effectiveContract,
    conversation: conversationFocus.messages,
    conversationCorpus: conversationHistory.messages,
    conversationTrace: {
      totalMessages: conversationHistory.trace.totalMessages,
      selectedMessages: conversationFocus.messages.length,
      estimatedInputTokens: conversationHistory.trace.estimatedInputTokens,
      estimatedOutputTokens: estimateConversationTokens(conversationFocus.messages),
      truncated: conversationHistory.trace.truncated
        || conversationFocus.messages.length < conversationHistory.trace.totalMessages,
      focusedOnLatestTurn: conversationFocus.focusedOnLatestTurn,
      selectionStrategy: conversationFocus.strategy,
      matchedAssistantMessages: conversationFocus.matchedAssistantMessages,
      roles: conversationFocus.messages.map((message) => message.role),
    },
  }).finally(async () => await toolRegistry.dispose());

  return {
    success: result.success,
    sessionId: result.sessionId,
    mode: options.operatingMode === "PLAN" ? "PLAN" : result.resultMode,
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
    metadata: toJsonObject({
      executionEngine: "AGENT_LOOP",
      taskKind: result.taskKind,
      outputKind: result.outputKind,
      ...(result.diffArtifactId ? {
        diffArtifactId: result.diffArtifactId,
        diffFileCount: result.diffFileCount ?? 0,
        diffAdditions: result.diffAdditions ?? 0,
        diffDeletions: result.diffDeletions ?? 0,
      } : {}),
      ...(result.delegationBatches === undefined ? {} : {
        delegationBatches: result.delegationBatches,
        subAgents: result.subAgents ?? 0,
      }),
    }),
  };
}
