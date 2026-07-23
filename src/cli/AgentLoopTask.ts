import { AgentLoop } from "../agent/AgentLoop.js";
import { resolveArtifactFollowUp } from "../agent/ArtifactFollowUp.js";
import { resolveRepositoryFollowUpTask } from "../agent/TaskFollowUp.js";
import { CommandRunner } from "../command/CommandRunner.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createConfiguredToolRegistry } from "../mcp/McpRegistryLoader.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import { createOpenAICompatibleClient, createStores } from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";
import { ReadonlySubAgentCoordinator } from "../agent/ReadonlySubAgentCoordinator.js";
import { loadAgentConfig, resolveMultiAgentPolicy } from "../config/AgentConfig.js";
import { resolveLlmConfig } from "../config/AgentConfig.js";
import type { AgentTaskContract } from "../agent/AgentTaskContract.js";
import { createDefaultAgentTaskContract } from "../agent/AgentTaskContract.js";
import {
  buildConversationHistoryWithTrace,
  estimateConversationTokens,
  focusConversationHistory,
} from "../session/ConversationHistory.js";
import { resolveFollowUpQuestion } from "../agent/FollowUpQuestionResolver.js";
import { resolveLocalDirectReply, resolveLocalSessionReply } from "./LocalReplyResolver.js";
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
  const conversationFocus = focusConversationHistory(conversationHistory.messages, userGoal, {
    maxMessages: 16,
    maxChars: 12_000,
  });
  const resolvedUserGoal = options.session
    ? await sessionStore.readRecords(options.session)
      .then((records) => resolveRepositoryFollowUpTask(userGoal, records)?.resolvedGoal)
      .catch(() => undefined)
    : undefined;
  const resolvedQuestion = taskContract.kind === "DIRECT_RESPONSE" || taskContract.kind === "WEB_RESEARCH"
    ? resolveFollowUpQuestion(userGoal, conversationHistory.messages)
    : undefined;
  const configuredModel = options.model ?? await loadAgentConfig(repoPath)
    .then((config) => resolveLlmConfig(config).openai.model)
    .catch(() => undefined);
  const artifactFollowUp = taskContract.kind === "DIRECT_RESPONSE"
    ? resolveArtifactFollowUp(repoPath, userGoal, recordsBeforeCurrent)
    : undefined;
  const deterministicAnswer = taskContract.kind === "DIRECT_RESPONSE"
    ? artifactFollowUp?.answer
      ?? resolveLocalSessionReply(userGoal, recordsBeforeCurrent)
      ?? resolveLocalDirectReply(repoPath, userGoal, configuredModel ? { configuredModel } : {})
    : undefined;
  const contextualInstructions = [
    ...(resolvedQuestion && resolvedQuestion !== userGoal
      ? [`Resolved current request: ${resolvedQuestion}`]
      : []),
    ...(conversationFocus.strategy === "LATEST_REFERENT"
      ? ["Referent rule: prioritize the immediately preceding exchange when resolving an implicit demonstrative. Older selected turns remain audit context, not competing current requests."]
      : []),
    ...(conversationFocus.strategy === "PRIOR_RESPONSE_AUDIT"
      ? [
        "Prior-response audit rule: visible assistant turns are the authoritative record of what you previously output, but they are not proof that those external facts are true.",
        "Inspect the exact prior wording before defending it. If it conflicts with the current answer, acknowledge and retract it instead of rewriting its intent or denying that it appeared.",
        "If the disputed original statement is not visible, say that the available conversation record is insufficient; never assert that you did not say it.",
      ]
      : []),
  ];
  const effectiveContract: AgentTaskContract = {
    ...taskContract,
    instructions: [...taskContract.instructions, ...contextualInstructions],
    ...(deterministicAnswer ? { deterministicAnswer } : {}),
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
  const multiAgent = resolveMultiAgentPolicy(await loadAgentConfig(repoPath), options.agents);
  const llmClient = await createOpenAICompatibleClient(repoPath, options);
  const { registry: toolRegistry, diagnostics } = effectiveContract.capabilities.mcpAccess
    ? await createConfiguredToolRegistry(repoPath)
    : { registry: createDefaultToolRegistry(), diagnostics: [] };
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
        subAgentCoordinator: new ReadonlySubAgentCoordinator({
          repoPath,
          createLlmClient: async () => await createOpenAICompatibleClient(repoPath, options),
        }),
      }
      : {}),
  });

  const result = await loop.run({
    userGoal: resolvedUserGoal ?? resolvedQuestion ?? userGoal,
    ...((resolvedUserGoal || resolvedQuestion) ? { originalUserGoal: userGoal } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    autoApprove: true,
    nonInteractive: options.nonInteractive === true,
    keepSessionActive: options.keepSessionActive === true,
    operatingMode: options.operatingMode ?? "EXECUTE",
    multiAgent,
    taskContract: effectiveContract,
    conversation: conversationFocus.messages,
    ...(effectiveContract.executionStrategy === "SINGLE_SHOT" && !effectiveContract.deterministicAnswer ? {
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
    } : {}),
    ...(artifactFollowUp ? { followUpResolution: artifactFollowUp } : {}),
  }).finally(async () => await toolRegistry.dispose());

  return {
    success: result.success,
    sessionId: result.sessionId,
    mode: options.operatingMode === "PLAN" ? "PLAN" : effectiveContract.resultMode,
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
