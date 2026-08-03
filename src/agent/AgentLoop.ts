import { randomUUID } from "node:crypto";
import { CommandRunner, isHighRiskCommandInput } from "../command/CommandRunner.js";
import type { CommandResult } from "../command/CommandRunner.js";
import { classifyVerificationCommandInput, validateVerificationCommandCompatibility } from "../command/CommandClassification.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import type {
  LlmClient,
  ToolSpec,
} from "../llm/LlmClient.js";
import { PatchManager } from "../patch/PatchManager.js";
import { TaskDiffService } from "../diff/TaskDiffService.js";
import { TaskDiffStore } from "../diff/TaskDiffStore.js";
import type { TaskDiffArtifact, WorkingTreeSnapshot } from "../diff/TaskDiffTypes.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import type { JsonObject } from "../session/SessionTypes.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/Tool.js";
import { formatToolErrorForModel } from "../tools/ToolErrorFormatter.js";
import {
  CommandBlockedError,
  CommandPermissionDeniedError,
  errorToCode,
  errorToDetails,
  errorToMessage,
} from "../utils/errors.js";
import { toJsonObject, toJsonValue } from "../utils/json.js";
import type { AgentDecision } from "./AgentDecision.js";
import { decisionToMessage } from "./AgentPlanner.js";
import { AgentState } from "./AgentState.js";
import { validateAgentDecisionGuardrails } from "./TaskGuardrails.js";
import type { LlmCallMetrics } from "../llm/OpenAICompatibleClient.js";
import type { AgentOperatingMode } from "./AgentOperatingMode.js";
import { isPlanModeReadOnlyTool, selectToolsForOperatingMode } from "./AgentOperatingMode.js";
import { checkpointToPayload, createAgentCheckpoint } from "./AgentCheckpoint.js";
import { AgentStateReducer } from "./AgentStateReducer.js";
import type { MultiAgentPolicy, SubAgentBatchResult, SubAgentCoordinator } from "./SubAgentTypes.js";
import { normalizeSubAgentTask } from "./SubAgentTypes.js";
import type { AgentTaskContract } from "./AgentTaskContract.js";
import { enforceCapabilityTruth } from "./CapabilityTruthGuard.js";
import {
  inferPriorResponseLocale,
  inspectPriorResponseConsistency,
  renderPriorResponseSafeFallback,
  type PriorResponseConsistencyViolation,
} from "./PriorResponseTruthGuard.js";
import {
  createDefaultAgentTaskContract,
  isToolAllowedByTaskContract,
} from "./AgentTaskContract.js";
import {
  estimateConversationTokens,
  type ConversationMessage,
} from "../session/ConversationHistory.js";
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventHandler,
  RuntimeConversationTrace,
} from "../observability/AgentRuntimeEvent.js";
import {
  buildWebLimitationFinal,
  isWebSynthesisReserveActive,
} from "./WebResearchProgress.js";
import { resolveTaskCollaborationPolicy } from "./TaskCollaborationPolicy.js";
import { fingerprintWorkingTree } from "./SubAgentWorktree.js";
import {
  negotiateCapabilities,
  selectToolsForCapabilityNegotiation,
  type CapabilityUpgrade,
} from "./CapabilityNegotiator.js";
import { decisionActionForReservedToolName } from "./CapabilityRegistry.js";
import { resolveTaskFrame } from "../runtime/TaskFrameResolver.js";
import { compileTaskFrameContract } from "../runtime/TaskFrameContract.js";
import { selectTaskFrameConversation } from "../runtime/TaskFrameConversationSelector.js";
import type { TaskFrame } from "../runtime/TaskFrame.js";
import { buildTaskCompletionContract } from "./TaskCompletionContract.js";
import {
  aggregateLlmMetrics,
  collaborationResultMetadata,
  commandInputFromDecision,
  commandResultToPayload,
  drainLlmCallMetrics,
  hasAppliedDelegatedPatch,
  hasSuccessfulDelegatedPatchProposal,
  hasSuccessfulDelegatedReview,
  isGitDiffData,
  isRecoverableLlmProtocolFailure,
  isRedundantSuccessfulIdempotentToolCall,
  isRedundantSuccessfulWebToolCall,
  previewToolResult,
  priorResponseGuardOptions,
  readEmbeddingCacheStats,
  renderCommandInput,
  stableDecisionKey,
  summarizeToolResult,
  taskDiffRecordMetadata,
  taskDiffResultMetadata,
} from "./AgentLoopSupport.js";

export interface AgentLoopOptions {
  repoPath: string;
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  eventStore: EventStore;
  commandRunner?: CommandRunner;
  permissionManager?: PermissionManager;
  patchManager?: PatchManager;
  contextBuilder?: ContextBuilder;
  onProgress?: AgentProgressHandler;
  askUser?: (message: string) => Promise<string>;
  subAgentCoordinator?: SubAgentCoordinator;
}

export interface AgentRunInput {
  userGoal: string;
  originalUserGoal?: string;
  sessionId?: string;
  maxSteps?: number;
  autoApprove?: boolean;
  nonInteractive?: boolean;
  keepSessionActive?: boolean;
  operatingMode?: AgentOperatingMode;
  multiAgent?: MultiAgentPolicy;
  taskContract?: AgentTaskContract;
  conversation?: ConversationMessage[];
  conversationCorpus?: ConversationMessage[];
  conversationTrace?: RuntimeConversationTrace;
}

export interface AgentRunResult {
  sessionId: string;
  success: boolean;
  summary: string;
  finalDiff: string;
  steps: number;
  error?: string;
  failureCode?: string;
  delegationBatches?: number;
  subAgents?: number;
  taskKind: AgentTaskContract["kind"];
  outputKind: AgentTaskContract["outputKind"];
  resultMode: AgentTaskContract["resultMode"];
  diffArtifactId?: string;
  diffFileCount?: number;
  diffAdditions?: number;
  diffDeletions?: number;
}

export type AgentProgressEvent = AgentRuntimeEvent;
export type AgentProgressHandler = AgentRuntimeEventHandler;

interface StepOutcome {
  result?: AgentRunResult;
  failed: boolean;
  failureKind?: "ACTION" | "GUARDRAIL";
  guardrailCode?: string;
}

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CONSECUTIVE_SAME_GUARDRAIL_FAILURES = 3;
const MAX_RECURRING_GUARDRAIL_FAILURES_WITHOUT_PROGRESS = 4;
const MAX_REPEATED_DECISIONS = 3;
const MAX_RECOVERABLE_LLM_PROTOCOL_FAILURES = 1;

function taskFrameOperation(frame: TaskFrame): string {
  if (frame.effects.repositoryWrite !== "NONE") return "CHANGE_REPOSITORY";
  if (frame.effects.knowledgeEvidence) return "QUERY_KNOWLEDGE";
  if (frame.effects.webEvidence) return "RESEARCH";
  if (frame.effects.repositoryRead) return "ANALYZE_REPOSITORY";
  if (frame.target === "PRODUCT" || frame.target === "SESSION") return "LOCAL_STATE";
  return "ANSWER";
}

export class AgentLoop {
  private readonly repoPath: string;
  private readonly llmClient: LlmClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly eventStore: EventStore;
  private readonly commandRunner: CommandRunner;
  private readonly permissionManager: PermissionManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly onProgress: AgentProgressHandler | undefined;
  private readonly askUser: ((message: string) => Promise<string>) | undefined;
  private readonly availableTools: ToolSpec[];
  private readonly subAgentCoordinator: SubAgentCoordinator | undefined;
  private activeState: AgentState | undefined;
  private activeTaskDiffBaseline: WorkingTreeSnapshot | undefined;
  private activeTaskDiffArtifact: TaskDiffArtifact | undefined;
  private progressSequence = 0;

  constructor(options: AgentLoopOptions) {
    this.repoPath = options.repoPath;
    this.llmClient = options.llmClient;
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.eventStore = options.eventStore;
    this.commandRunner = options.commandRunner ?? new CommandRunner({ repoPath: options.repoPath });
    this.permissionManager = options.permissionManager ?? new PermissionManager();
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder({ repoPath: options.repoPath });
    this.onProgress = options.onProgress;
    this.askUser = options.askUser;
    this.subAgentCoordinator = options.subAgentCoordinator;
    this.availableTools = this.toolRegistry.listSpecs();
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.activeState = undefined;
    this.activeTaskDiffBaseline = undefined;
    this.activeTaskDiffArtifact = undefined;
    this.progressSequence = 0;
    const userGoal = input.userGoal.trim();
    const originalUserGoal = input.originalUserGoal?.trim() || userGoal;
    if (userGoal.length === 0) {
      throw new Error("User goal cannot be empty");
    }

    const operatingMode = input.operatingMode ?? "EXECUTE";
    // CLI and programmatic callers share the same least-privilege TaskFrame
    // bootstrap. No natural-language router exists before the model frame.
    let taskContract = input.taskContract ?? createDefaultAgentTaskContract();
    const sessionId = await this.ensureSession(originalUserGoal, input.sessionId, operatingMode);
    await this.emit({ type: "session", sessionId });
    let understandingMetrics: LlmCallMetrics[] = [];
    let understandingDurationMs = 0;
    let taskFrameResolutionFailure: string | undefined;
    let understandingEvent: Extract<AgentRuntimeEvent, { type: "understanding" }> | undefined;
    if (
      taskContract.taskFrame === undefined
    ) {
      const startedAt = Date.now();
      const resolved = await resolveTaskFrame({
        userGoal,
        llmClient: this.llmClient,
        availableTools: this.availableTools,
        ...(input.conversation ? { conversation: input.conversation } : {}),
      });
      understandingDurationMs = Date.now() - startedAt;
      understandingMetrics = drainLlmCallMetrics(this.llmClient);
      if (resolved.source === "UNRESOLVED") {
        taskFrameResolutionFailure = resolved.reason;
        understandingEvent = {
          type: "understanding",
          source: "MODEL_UNRESOLVED",
          operation: "UNRESOLVED",
          target: "UNKNOWN",
          mutationRequirement: "NONE",
          confidence: 0,
          reason: resolved.reason,
        };
      } else {
        taskContract = compileTaskFrameContract({
          frame: resolved.frame,
          operatingMode,
          multiAgentAvailable: input.multiAgent?.enabled === true
            && this.subAgentCoordinator !== undefined,
        });
        if (
          resolved.frame.collaboration.requestedAgents !== null
          && input.multiAgent?.enabled === true
        ) {
          input = {
            ...input,
            multiAgent: {
              ...input.multiAgent,
              maxConcurrency: resolved.frame.collaboration.requestedAgents,
              maxTasksPerRun: Math.max(
                input.multiAgent.maxTasksPerRun,
                resolved.frame.collaboration.requestedAgents,
              ),
            },
          };
        }
        if (input.conversationCorpus?.length) {
          const selection = selectTaskFrameConversation({
            messages: input.conversationCorpus,
            frame: resolved.frame,
          });
          input = {
            ...input,
            conversation: selection.messages,
            conversationTrace: {
              totalMessages: input.conversationCorpus.length,
              selectedMessages: selection.messages.length,
              estimatedInputTokens: input.conversationTrace?.estimatedInputTokens
                ?? estimateConversationTokens(input.conversationCorpus),
              estimatedOutputTokens: estimateConversationTokens(selection.messages),
              truncated: selection.messages.length < input.conversationCorpus.length,
              focusedOnLatestTurn: false,
              selectionStrategy: "TASK_FRAME_RETRIEVAL",
              matchedAssistantMessages: selection.matchedAssistantMessages,
              roles: selection.messages.map((message) => message.role),
            },
          };
        }
        understandingEvent = {
          type: "understanding",
          source: "MODEL_TASK_FRAME",
          operation: taskFrameOperation(resolved.frame),
          target: resolved.frame.target,
          mutationRequirement: resolved.frame.effects.repositoryWrite,
          confidence: resolved.frame.confidence,
          reason: resolved.reason,
        };
      }
    } else if (taskContract.taskFrame) {
      const frame = taskContract.taskFrame;
      understandingEvent = {
        type: "understanding",
        source: "MODEL_TASK_FRAME",
        operation: taskFrameOperation(frame),
        target: frame.target,
        mutationRequirement: frame.effects.repositoryWrite,
        confidence: frame.confidence,
        reason: frame.rationale,
      };
    }

    const recoveredCheckpoint = input.sessionId
      ? await new AgentStateReducer(this.sessionStore).recover(sessionId, operatingMode, userGoal)
      : undefined;

    const state = new AgentState({
      sessionId,
      runId: recoveredCheckpoint?.runId ?? randomUUID(),
      repoPath: this.repoPath,
      userGoal,
      maxSteps: input.maxSteps ?? taskContract.maxSteps,
      operatingMode,
      ...(recoveredCheckpoint ? { recoveredCheckpoint } : {}),
      multiAgentEnabled: input.multiAgent?.enabled === true
        && this.subAgentCoordinator !== undefined,
      taskContract,
    });
    this.activeState = state;
    if (understandingEvent) await this.emit(understandingEvent);
    await this.emit({
      type: "task_contract",
      kind: taskContract.kind,
      outputKind: taskContract.outputKind,
    });
    if (understandingDurationMs > 0) {
      const understandingMode = "task_frame";
      await this.emit({ type: "llm", phase: "started", mode: understandingMode });
      await this.recordLlmUsage(
        state,
        understandingMetrics,
        understandingMode,
        understandingDurationMs,
      );
    }
    if (taskContract.capabilities.repositoryWrite) {
      this.activeTaskDiffBaseline = await new TaskDiffService({ repoPath: this.repoPath })
        .captureWorkingTree()
        .catch(() => undefined);
    }

    if (input.conversationTrace) {
      await this.eventStore.appendEvent(sessionId, {
        type: "CONVERSATION_CONTEXT_BUILT",
        payload: toJsonObject({ ...input.conversationTrace }),
      });
      await this.emit({ type: "conversation", trace: input.conversationTrace });
    }

    if (recoveredCheckpoint) {
      state.setLastError(recoveredCheckpoint.inFlightAction
        ? `Recovered after interruption during ${recoveredCheckpoint.inFlightAction}; inspect current repository state before retrying.`
        : recoveredCheckpoint.lastError ?? null);
      await this.eventStore.appendEvent(sessionId, {
        type: "AGENT_STATE_RESTORED",
        payload: {
          runId: state.runId,
          checkpointRecordedAt: recoveredCheckpoint.recordedAt,
          previousGoal: recoveredCheckpoint.userGoal,
          previousTotalSteps: recoveredCheckpoint.totalSteps,
          hadInFlightAction: Boolean(recoveredCheckpoint.inFlightAction),
        },
      });
    }

    await this.recordUserMessage(state, originalUserGoal);
    if (taskFrameResolutionFailure) {
      const error = [
        "TASK_FRAME_UNRESOLVED:",
        "the semantic TaskFrame could not be resolved; one bounded repair was attempted when the failure was structurally repairable.",
        "AgentLoop stopped before executing tools or accepting a success claim, because falling back to an unverified intent could apply the wrong completion contract.",
        taskFrameResolutionFailure,
      ].join(" ");
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      return await this.fail(state, error, input, "TASK_FRAME_UNRESOLVED");
    }
    await this.recordCheckpoint(state);
    let consecutiveFailures = 0;
    let consecutiveSameGuardrailFailures = 0;
    let previousGuardrailCode: string | undefined;
    let previousDecisionKey: string | undefined;
    let repeatedDecisionCount = 0;
    let recoverableLlmProtocolFailures = 0;
    let previousFailedDecisionFingerprint: string | undefined;
    let repeatedFailedDecisionCount = 0;
    const recurringGuardrailFailures = new Map<string, number>();

    while (!state.isStepLimitReached()) {
      const contractTools = selectToolsForCapabilityNegotiation(
        this.availableTools,
        state.taskContract,
      );
      const synthesisReserveActive = isWebSynthesisReserveActive(state);
      const availableTools = synthesisReserveActive
        ? []
        : selectToolsForOperatingMode(contractTools, state.operatingMode);
      const context = await this.contextBuilder.build(state);
      const contextTrace = this.contextBuilder.getLastTrace();
      if (contextTrace) {
        await this.eventStore.appendEvent(state.sessionId, {
          type: "CONTEXT_BUILT",
          payload: { trace: toJsonValue(contextTrace) },
        });
        await this.emit({ type: "context", trace: contextTrace });
        if (contextTrace.embeddingCache) {
          await this.emit({ type: "cache", cache: "embedding", ...contextTrace.embeddingCache });
        }
      }
      const decision = await this.readDecision(
        state,
        userGoal,
        context,
        availableTools,
        input.conversation,
        originalUserGoal,
        input.conversationTrace?.truncated === true,
        synthesisReserveActive,
      );

      if (
        decision.type === "FAILED"
        && isRecoverableLlmProtocolFailure(decision.error)
        && recoverableLlmProtocolFailures < MAX_RECOVERABLE_LLM_PROTOCOL_FAILURES
      ) {
        recoverableLlmProtocolFailures += 1;
        const message = [
          "RECOVERABLE_LLM_PROTOCOL_ERROR:",
          decision.error,
          "The provider response was not a valid AgentDecision.",
          "Keep the completed work and observations; retry with exactly one short AgentDecision JSON object.",
        ].join(" ");
        state.setLastError(message);
        state.addAssistantMessage(message);
        await this.recordError(state.sessionId, message);
        await this.emit({
          type: "guardrail",
          code: "RECOVERABLE_LLM_PROTOCOL_ERROR",
          message,
        });
        state.incrementStep();
        await this.recordCheckpoint(state);
        continue;
      }
      recoverableLlmProtocolFailures = 0;

      state.addDecision(decision);
      await this.emit({
        type: "decision",
        decisionType: decision.type,
        message: decisionToMessage(decision),
        decision,
      });
      await this.recordDecision(state.sessionId, decision);
      state.addAssistantMessage(decisionToMessage(decision));
      await this.recordDecisionCheckpoint(state, decision);

      if (synthesisReserveActive) {
        const proposedSummary = decision.type === "FINAL"
          ? decision.summary
          : decision.type === "FAILED"
            ? decision.error
            : undefined;
        const limitation = buildWebLimitationFinal(state, proposedSummary);
        if (limitation) {
          await this.emit({
            type: "guardrail",
            code: "WEB_LIMITATION_FINAL_APPLIED",
            message: "The Web evidence threshold could not be completed within the action budget; returning a transparent limitation final instead of retrying.",
          });
          return await this.finish(
            state,
            limitation.summary,
            limitation.success,
            input,
          );
        }
      }

      const decisionKey = stableDecisionKey(decision);
      if (decisionKey === previousDecisionKey) {
        repeatedDecisionCount += 1;
      } else {
        repeatedDecisionCount = 1;
        previousDecisionKey = decisionKey;
      }

      if (repeatedDecisionCount > MAX_REPEATED_DECISIONS) {
        const error = state.lastError
          ? `Agent repeated a decision without resolving the active guardrail: ${state.lastError}`
          : "Agent repeated the same decision too many times";
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input, "REPEATED_DECISION");
      }

      const progressBefore = completionProgressFingerprint(state);
      const outcome = await this.handleDecision(state, decision, input);
      if (outcome.result) {
        return outcome.result;
      }
      const madeCompletionProgress = completionProgressFingerprint(state) !== progressBefore;
      if (madeCompletionProgress) recurringGuardrailFailures.clear();

      if (outcome.failed && outcome.failureKind === "GUARDRAIL") {
        consecutiveFailures = 0;
        if (outcome.guardrailCode === previousGuardrailCode) {
          consecutiveSameGuardrailFailures += 1;
        } else {
          previousGuardrailCode = outcome.guardrailCode;
          consecutiveSameGuardrailFailures = 1;
        }
        const guardrailCode = outcome.guardrailCode ?? "(unknown)";
        recurringGuardrailFailures.set(
          guardrailCode,
          (recurringGuardrailFailures.get(guardrailCode) ?? 0) + 1,
        );
      } else {
        consecutiveSameGuardrailFailures = 0;
        previousGuardrailCode = undefined;
        consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0;
      }

      if (outcome.failed && outcome.failureKind !== "GUARDRAIL") {
        const failureFingerprint = `${decisionKey}\n${state.lastError ?? "(unknown failure)"}`;
        if (failureFingerprint === previousFailedDecisionFingerprint) {
          repeatedFailedDecisionCount += 1;
        } else {
          previousFailedDecisionFingerprint = failureFingerprint;
          repeatedFailedDecisionCount = 1;
        }
      } else {
        previousFailedDecisionFingerprint = undefined;
        repeatedFailedDecisionCount = 0;
      }

      if (repeatedFailedDecisionCount >= 2) {
        const error = `Agent repeated a failed decision without resolving the active error. ${state.lastError ?? "No failure detail was recorded."}`;
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input, "REPEATED_FAILED_DECISION");
      }

      if (consecutiveSameGuardrailFailures > MAX_CONSECUTIVE_SAME_GUARDRAIL_FAILURES) {
        const error = [
          `Agent could not satisfy guardrail ${previousGuardrailCode ?? "(unknown)"} after repeated attempts.`,
          state.lastError ?? "No recovery detail was recorded.",
        ].join(" ");
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input, "REPEATED_GUARDRAIL");
      }
      const recurringGuardrail = [...recurringGuardrailFailures.entries()]
        .find(([, count]) => count >= MAX_RECURRING_GUARDRAIL_FAILURES_WITHOUT_PROGRESS);
      if (recurringGuardrail) {
        const error = [
          `Agent entered a recurring guardrail cycle without new completion evidence (${recurringGuardrail[0]} repeated ${String(recurringGuardrail[1])} times).`,
          state.lastError ?? "No recovery detail was recorded.",
        ].join(" ");
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input, "RECURRING_GUARDRAIL");
      }
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        const error = "Agent failed too many consecutive steps";
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input, "CONSECUTIVE_FAILURES");
      }

      state.incrementStep();
      await this.recordCheckpoint(state);
    }

    const error = state.lastError
      ? `Agent stopped after reaching max steps (${state.maxSteps}). Last unresolved issue: ${state.lastError}`
      : `Agent stopped after reaching max steps (${state.maxSteps})`;
    await this.recordError(sessionId, error);
    return await this.fail(state, error, input, "STEP_LIMIT_REACHED");
  }

  private async handleDecision(
    state: AgentState,
    decision: AgentDecision,
    input: AgentRunInput,
  ): Promise<StepOutcome> {
    const planViolation = this.validatePlanModeDecision(state, decision);
    if (planViolation) {
      state.setLastError(planViolation);
      await this.recordError(state.sessionId, planViolation);
      await this.emit({ type: "guardrail", code: planViolation.split(":", 1)[0] ?? "PLAN_MODE_VIOLATION", message: planViolation });
      return {
        failed: true,
        failureKind: "GUARDRAIL",
        guardrailCode: planViolation.split(":", 1)[0] ?? "PLAN_MODE_VIOLATION",
      };
    }

    const negotiation = await this.negotiateDecisionCapabilities(state, decision);
    if (negotiation) return negotiation;

    switch (decision.type) {
      case "PLAN":
        await this.emit({ type: "plan", message: decision.message });
        return { failed: false };

      case "TOOL_CALL":
        if (this.availableTools.some((tool) => tool.name === decision.toolName)
          && !isToolAllowedByTaskContract(
            this.availableTools.find((tool) => tool.name === decision.toolName),
            state.taskContract,
          )) {
          const code = "TASK_CAPABILITY_TOOL_BLOCKED";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: tool ${decision.toolName} is not enabled for ${state.taskContract.kind}`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        {
          const guardrail = await this.guardDecisionThenContinue(state, decision);
          if (guardrail) return guardrail;
        }
        if (isRedundantSuccessfulWebToolCall(state, decision.toolName, decision.input)) {
          const code = "REDUNDANT_WEB_TOOL_CALL";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: ${decision.toolName} already succeeded with the same input in this run; use the gathered evidence or choose a materially different source`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        if (isRedundantSuccessfulIdempotentToolCall(
          state,
          this.availableTools.find((tool) => tool.name === decision.toolName),
          this.availableTools,
          decision.toolName,
          decision.input,
        )) {
          const code = "REDUNDANT_IDEMPOTENT_TOOL_CALL";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: ${decision.toolName} already succeeded with the same input and no intervening action has changed observable state; use the existing result or choose materially different input`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        return { failed: await this.executeToolDecision(state, decision.toolName, decision.input, input) };

      case "DELEGATE":
        if (!state.taskContract.capabilities.delegation) {
          const code = "TASK_CAPABILITY_DELEGATION_BLOCKED";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: delegation is not enabled for ${state.taskContract.kind}`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        return await this.executeDelegationDecision(state, decision, input);

      case "APPLY_DELEGATED_PATCH":
        if (!state.taskContract.capabilities.repositoryWrite) {
          const code = "TASK_CAPABILITY_PATCH_BLOCKED";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: delegated repository writes are not enabled for ${state.taskContract.kind}`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        return await this.executeDelegatedPatchDecision(state, decision, input);

      case "APPLY_PATCH":
        if (!state.taskContract.capabilities.repositoryWrite) {
          const code = "TASK_CAPABILITY_PATCH_BLOCKED";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: repository writes are not enabled for ${state.taskContract.kind}`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        {
          const collaborationIntent = resolveTaskCollaborationPolicy(
            state.taskContract,
          );
          if (
            collaborationIntent.preference === "REQUIRED"
            && collaborationIntent.requestsChangeProposal
            && !hasAppliedDelegatedPatch(state)
          ) {
            const code = "PARENT_PATCH_BLOCKED_PENDING_DELEGATED_PROPOSAL";
            return {
              failed: await this.recordCapabilityViolation(
                state,
                `${code}: the user explicitly assigned implementation to a subagent; obtain a successful child proposal and merge it with APPLY_DELEGATED_PATCH instead of writing directly from the parent`,
              ),
              failureKind: "GUARDRAIL",
              guardrailCode: code,
            };
          }
        }
        return await this.executePatchDecision(state, decision, input);

      case "RUN_COMMAND":
        if (!state.taskContract.capabilities.commandExecution) {
          const code = "TASK_CAPABILITY_COMMAND_BLOCKED";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: command execution is not enabled for ${state.taskContract.kind}`,
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        return await this.executeCommandDecision(state, decision, input);

      case "ASK_USER":
        return await this.guardDecisionThenContinue(state, decision)
          ?? await this.executeAskUserDecision(state, decision.message, input);

      case "FINAL":
        return await this.guardDecisionThenContinue(state, decision)
          ?? { failed: false, result: await this.finish(state, decision.summary, decision.success, input) };

      case "FAILED":
        return { failed: true, result: await this.fail(state, decision.error, input, "MODEL_REPORTED_FAILURE") };
    }
  }

  private async negotiateDecisionCapabilities(
    state: AgentState,
    decision: AgentDecision,
  ): Promise<StepOutcome | undefined> {
    const result = negotiateCapabilities({
      contract: state.taskContract,
      decision,
      availableTools: this.availableTools,
      operatingMode: state.operatingMode,
      multiAgentAvailable: state.multiAgentEnabled,
    });
    if (result.status === "UNCHANGED") return undefined;
    if (result.status === "DENIED") {
      const error = `${result.denial.code}: ${result.denial.reason}`;
      return {
        failed: await this.recordCapabilityViolation(state, error),
        failureKind: "GUARDRAIL",
        guardrailCode: result.denial.code,
      };
    }

    if (
      result.upgrade.contract.capabilities.repositoryWrite
      && !state.taskContract.capabilities.repositoryWrite
      && !this.activeTaskDiffBaseline
    ) {
      this.activeTaskDiffBaseline = await new TaskDiffService({ repoPath: this.repoPath })
        .captureWorkingTree()
        .catch(() => undefined);
    }
    state.upgradeTaskContract(result.upgrade.contract);
    await this.recordTaskContractUpgrade(state, result.upgrade);
    return undefined;
  }

  private async recordTaskContractUpgrade(
    state: AgentState,
    upgrade: CapabilityUpgrade,
  ): Promise<void> {
    await this.eventStore.appendEvent(state.sessionId, {
      type: "TASK_CONTRACT_UPGRADED",
      payload: {
        previousKind: upgrade.previousKind,
        kind: state.taskContract.kind,
        action: upgrade.action,
        granted: upgrade.granted,
        ...(upgrade.grantedTools ? { grantedTools: upgrade.grantedTools } : {}),
        reason: upgrade.reason,
        repositoryWrite: state.taskContract.capabilities.repositoryWrite,
        commandExecution: state.taskContract.capabilities.commandExecution,
      },
    });
    await this.emit({
      type: "capability_upgrade",
      previousKind: upgrade.previousKind,
      kind: state.taskContract.kind,
      action: upgrade.action,
      granted: upgrade.granted,
      ...(upgrade.grantedTools ? { grantedTools: upgrade.grantedTools } : {}),
    });
    await this.emit({
      type: "task_contract",
      kind: state.taskContract.kind,
      outputKind: state.taskContract.outputKind,
    });
  }

  private async recordCapabilityViolation(state: AgentState, error: string): Promise<true> {
    state.setLastError(error);
    await this.recordError(state.sessionId, error);
    await this.emit({ type: "guardrail", code: error.split(":", 1)[0] ?? "CAPABILITY_VIOLATION", message: error });
    return true;
  }

  private async executeDelegationDecision(
    state: AgentState,
    decision: Extract<AgentDecision, { type: "DELEGATE" }>,
    input: AgentRunInput,
  ): Promise<StepOutcome> {
    const policy = input.multiAgent;
    if (!state.multiAgentEnabled || !policy || !this.subAgentCoordinator) {
      const error = "MULTI_AGENT_DISABLED: DELEGATE requires an enabled multi-agent policy";
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      return { failed: true };
    }
    if (state.delegationBatches.length >= policy.maxBatchesPerRun) {
      const error = `MULTI_AGENT_BUDGET_EXHAUSTED: maximum ${String(policy.maxBatchesPerRun)} delegation batches reached`;
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      return { failed: true };
    }
    const tasks = decision.tasks.map(normalizeSubAgentTask);
    const previousTaskCount = state.delegationBatches.reduce((total, batch) => total + batch.results.length, 0);
    if (previousTaskCount + tasks.length > policy.maxTasksPerRun) {
      const error = `MULTI_AGENT_BUDGET_EXHAUSTED: maximum ${String(policy.maxTasksPerRun)} child tasks reached`;
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      return { failed: true };
    }

    await this.emit({
      type: "agents",
      phase: "started",
      tasks: tasks.length,
      message: decision.reason,
      taskDetails: tasks.map((task) => ({
        taskId: task.id,
        role: task.role,
        access: task.access,
        dependsOn: task.dependsOn,
      })),
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "SUBAGENT_BATCH_STARTED",
      payload: { reason: decision.reason, taskCount: tasks.length },
    });

    let batch: SubAgentBatchResult;
    try {
      batch = await this.subAgentCoordinator.runBatch({
        parentRunId: state.runId,
        originalGoal: state.userGoal,
        tasks,
        policy,
        onProgress: async (event) => {
          await this.emit({
            type: "agent_task",
            ...event,
          });
        },
      });
    } catch (error) {
      const message = `MULTI_AGENT_COORDINATOR_FAILED: ${errorToMessage(error)}`;
      state.setLastError(message);
      await this.recordError(state.sessionId, message, error);
      await this.eventStore.appendEvent(state.sessionId, {
        type: "SUBAGENT_BATCH_FAILED",
        payload: { status: "FAILED", taskCount: tasks.length, error: message },
      });
      await this.emit({ type: "agents", phase: "failed", tasks: tasks.length, message });
      return { failed: true };
    }
    state.addDelegationBatch(batch);
    await this.recordSubAgentBatch(state.sessionId, batch);
    const failed = batch.status === "FAILED";
    const incomplete = batch.status !== "COMPLETED";
    const failureDetails = batch.results
      .filter((result) => result.status !== "COMPLETED")
      .map((result) => `${result.taskId}: ${result.error ?? result.summary}`);
    const message = [
      `${batch.status}: ${String(batch.results.filter((result) => result.status === "COMPLETED").length)}/${String(batch.results.length)} child tasks completed`,
      ...(failureDetails.length > 0 ? [`Failures: ${failureDetails.join(" | ")}`] : []),
    ].join(". ");
    await this.emit({
      type: "agents",
      phase: failed ? "failed" : "finished",
      tasks: batch.results.length,
      message,
      taskDetails: tasks.map((task) => {
        const result = batch.results.find((candidate) => candidate.taskId === task.id);
        return {
          taskId: task.id,
          role: task.role,
          access: task.access,
          dependsOn: task.dependsOn,
          ...(result ? {
            status: result.status,
            ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
            ...(result.error ? { error: result.error } : {}),
          } : {}),
        };
      }),
    });
    if (incomplete) {
      state.setLastError(`MULTI_AGENT_BATCH_FAILED: ${message}`);
      await this.recordError(state.sessionId, state.lastError);
      const collaborationIntent = resolveTaskCollaborationPolicy(
        state.taskContract,
      );
      const requiredWriterDeadEnd = collaborationIntent.preference === "REQUIRED"
        && collaborationIntent.requestsChangeProposal
        && !hasSuccessfulDelegatedPatchProposal(state)
        && state.delegationBatches.length >= policy.maxBatchesPerRun;
      const requiredReviewDeadEnd = collaborationIntent.preference === "REQUIRED"
        && collaborationIntent.requestsReview
        && !hasSuccessfulDelegatedReview(state)
        && state.delegationBatches.length >= policy.maxBatchesPerRun;
      if (requiredWriterDeadEnd || requiredReviewDeadEnd) {
        const unmetRequirement = requiredWriterDeadEnd
          ? "child-authored change"
          : "dependent child review";
        const error = [
          `REQUIRED_DELEGATION_EXHAUSTED: all ${String(policy.maxBatchesPerRun)} allowed delegation batches were used`,
          `without satisfying the requested ${unmetRequirement}, so it can no longer be completed in this run.`,
          `Child failures: ${failureDetails.join(" | ") || "no detailed child error was recorded"}.`,
          "The parent worktree was not modified as a fallback.",
        ].join(" ");
        await this.recordError(state.sessionId, error);
        return { failed: true, result: await this.fail(state, error, input, "REQUIRED_DELEGATION_EXHAUSTED") };
      }
      return { failed };
    }
    state.setLastError(null);
    return { failed: false };
  }

  private async executeDelegatedPatchDecision(
    state: AgentState,
    decision: Extract<AgentDecision, { type: "APPLY_DELEGATED_PATCH" }>,
    input: AgentRunInput,
  ): Promise<StepOutcome> {
    const result = [...state.delegationBatches]
      .reverse()
      .flatMap((batch) => [...batch.results].reverse())
      .find((candidate) => candidate.taskId === decision.taskId);
    if (!result?.proposedPatch || result.status !== "COMPLETED") {
      const code = "DELEGATED_PATCH_NOT_FOUND";
      return {
        failed: await this.recordCapabilityViolation(
          state,
          `${code}: no completed patch proposal exists for child task ${decision.taskId}`,
        ),
        failureKind: "GUARDRAIL",
        guardrailCode: code,
      };
    }
    if (result.baselineFingerprint) {
      const currentFingerprint = await fingerprintWorkingTree(this.repoPath);
      if (currentFingerprint !== result.baselineFingerprint) {
        const recheck = await new PatchManager({ repoPath: this.repoPath })
          .validatePatch({ patch: result.proposedPatch });
        if (!recheck.success) {
          const code = "DELEGATED_PATCH_CONFLICT";
          return {
            failed: await this.recordCapabilityViolation(
              state,
              `${code}: parent worktree changed after child ${decision.taskId} started and its proposal no longer applies cleanly; re-delegate against the current baseline. ${recheck.stderr ?? recheck.error ?? ""}`.trim(),
            ),
            failureKind: "GUARDRAIL",
            guardrailCode: code,
          };
        }
        await this.emit({
          type: "agents",
          phase: "finished",
          tasks: 1,
          message: `Parent worktree changed after ${decision.taskId} started; the delegated patch was revalidated and still applies cleanly.`,
        });
      }
    }
    const declaredReviewers = state.delegationBatches
      .flatMap((batch) => batch.results)
      .filter((candidate) => candidate.reviewedTaskIds?.includes(decision.taskId));
    if (declaredReviewers.some((reviewer) => reviewer.status !== "COMPLETED")) {
      const code = "DELEGATED_PATCH_REVIEW_INCOMPLETE";
      return {
        failed: await this.recordCapabilityViolation(
          state,
          `${code}: a declared reviewer for ${decision.taskId} did not complete`,
        ),
        failureKind: "GUARDRAIL",
        guardrailCode: code,
      };
    }
    const collaborationIntent = resolveTaskCollaborationPolicy(
      state.taskContract,
    );
    if (
      collaborationIntent.preference === "REQUIRED"
      && collaborationIntent.requestsReview
      && !hasSuccessfulDelegatedReview(state, decision.taskId)
    ) {
      const code = "DELEGATED_PATCH_REVIEW_INCOMPLETE";
      return {
        failed: await this.recordCapabilityViolation(
          state,
          `${code}: the user explicitly requested a dependent subagent review for ${decision.taskId}, but none completed`,
        ),
        failureKind: "GUARDRAIL",
        guardrailCode: code,
      };
    }
    return await this.executePatchDecision(state, {
      type: "APPLY_PATCH",
      patch: result.proposedPatch,
      description: `${decision.description} (delegated by ${decision.taskId})`,
    }, input);
  }

  private validatePlanModeDecision(state: AgentState, decision: AgentDecision): string | undefined {
    if (state.operatingMode !== "PLAN") {
      return undefined;
    }

    if (
      decision.type === "APPLY_PATCH"
      || decision.type === "APPLY_DELEGATED_PATCH"
      || decision.type === "RUN_COMMAND"
    ) {
      return `PLAN_MODE_MUTATION_BLOCKED: ${decision.type} is not allowed in read-only plan mode`;
    }

    if (decision.type === "TOOL_CALL") {
      const spec = this.availableTools.find((tool) => tool.name === decision.toolName);
      if (!isPlanModeReadOnlyTool(spec)) {
        return `PLAN_MODE_TOOL_BLOCKED: tool ${decision.toolName} is not read-only or is unavailable`;
      }
    }
    return undefined;
  }

  private async guardDecisionThenContinue(
    state: AgentState,
    decision: AgentDecision,
  ): Promise<StepOutcome | undefined> {
    const violation = validateAgentDecisionGuardrails(state, decision);
    if (!violation) {
      return undefined;
    }

    state.setLastError(`${violation.code}: ${violation.message}`);
    await this.recordError(state.sessionId, state.lastError);
    await this.emit({ type: "guardrail", code: violation.code, message: violation.message });
    return {
      failed: true,
      failureKind: "GUARDRAIL",
      guardrailCode: violation.code,
    };
  }

  private async executeToolDecision(
    state: AgentState,
    toolName: string,
    toolInput: JsonObject,
    input: AgentRunInput,
  ): Promise<boolean> {
    const reservedAction = decisionActionForReservedToolName(toolName);
    if (reservedAction) {
      const error = `DECISION_ACTION_REQUIRED: ${toolName} is not a callable tool. Return the top-level ${reservedAction} AgentDecision instead.`;
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      await this.emit({ type: "guardrail", code: "DECISION_ACTION_REQUIRED", message: error });
      return true;
    }
    await this.emit({ type: "tool", toolName, input: toolInput });
    const startedAt = Date.now();
    const result = await this.toolRegistry.execute(toolName, toolInput, this.buildToolContext(state.sessionId, input));
    const resultSummary = result.success ? summarizeToolResult(toolName, result.data) : undefined;
    await this.emit({
      type: "tool_result",
      toolName,
      success: result.success,
      durationMs: Date.now() - startedAt,
      ...(resultSummary ? { summary: resultSummary } : {}),
      ...(result.success ? { resultPreview: previewToolResult(result.data) } : {}),
      ...(!result.success ? { error: formatToolErrorForModel(result.error, `Tool failed: ${toolName}`) } : {}),
    });
    const embeddingCache = readEmbeddingCacheStats(result.metadata?.embeddingCache);
    if (embeddingCache) {
      await this.emit({ type: "cache", cache: "embedding", ...embeddingCache });
    }

    state.addToolResult({
      toolName,
      input: toolInput,
      result,
    });

    if (!result.success) {
      state.setLastError(formatToolErrorForModel(result.error, `Tool failed: ${toolName}`));
      await this.recordError(state.sessionId, state.lastError);
      return true;
    } else if (toolName === "git_diff" && isGitDiffData(result.data)) {
      state.finalDiff = result.data.diff;
    }

    state.setLastError(null);
    return false;
  }

  private async executePatchDecision(
    state: AgentState,
    decision: Extract<AgentDecision, { type: "APPLY_PATCH" }>,
    input: AgentRunInput,
  ): Promise<StepOutcome> {
    await this.emit({ type: "patch", description: decision.description ?? "apply_patch" });
    const startedAt = Date.now();
    const result = await this.toolRegistry.execute(
      "apply_patch",
      { patch: decision.patch, checkBeforeApply: true },
      this.buildToolContext(state.sessionId, input),
    );
    const patchError = result.success
      ? undefined
      : formatToolErrorForModel(result.error, "Patch application failed");
    await this.emit({
      type: "patch_result",
      success: result.success,
      durationMs: Date.now() - startedAt,
      description: decision.description,
      ...(patchError ? { error: patchError } : {}),
    });

    state.addPatchResult({
      patch: decision.patch,
      ...(decision.description ? { description: decision.description } : {}),
      result,
    });

    if (!result.success) {
      const error = patchError ?? "Patch application failed";
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      if (result.error?.code === "PATCH_PERMISSION_DENIED") {
        return { failed: true, result: await this.fail(state, error, input, "PATCH_PERMISSION_DENIED") };
      }
      return { failed: true };
    }

    state.setLastError(null);
    return { failed: false };
  }

  private async executeCommandDecision(
    state: AgentState,
    decision: Extract<AgentDecision, { type: "RUN_COMMAND" }>,
    input: AgentRunInput,
  ): Promise<StepOutcome> {
    const commandInput = commandInputFromDecision(decision);
    const command = renderCommandInput(commandInput);
    const compatibilityIssue = validateVerificationCommandCompatibility(commandInput);
    if (compatibilityIssue) {
      const fallback = await this.executeBuiltInVerificationFallback(state, input, {
        reason: `${compatibilityIssue.message} ${compatibilityIssue.guidance}`,
        ...(compatibilityIssue.suggestedVerifyFilePath
          ? { preferredPath: compatibilityIssue.suggestedVerifyFilePath }
          : {}),
        requireRepositoryChange: false,
      });
      if (fallback) return fallback;
      const error = `${compatibilityIssue.code}: ${compatibilityIssue.message} ${compatibilityIssue.guidance}`;
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      await this.emit({ type: "guardrail", code: compatibilityIssue.code, message: error });
      return { failed: true, failureKind: "GUARDRAIL", guardrailCode: compatibilityIssue.code };
    }
    const isHighRiskCommand = isHighRiskCommandInput(commandInput);
    await this.emit({ type: "command", command, description: decision.description });

    const permission = await this.permissionManager.check({
      level: PermissionLevel.DANGEROUS,
      action: isHighRiskCommand ? "run_high_risk_command" : "run_command",
      description: decision.description ?? "Run command requested by the agent.",
      command,
      requiresExplicitApproval: isHighRiskCommand,
      ...(input.autoApprove === undefined ? {} : { autoApprove: input.autoApprove }),
      ...(input.nonInteractive === undefined ? {} : { nonInteractive: input.nonInteractive }),
    });

    if (!permission.allowed) {
      const error = permission.mode === "BLOCKED"
        ? new CommandBlockedError(permission.reason ?? "Command was blocked", { permission })
        : new CommandPermissionDeniedError(permission.reason ?? "Command permission denied", { permission });
      const message = error.message;
      state.setLastError(message);
      await this.recordError(state.sessionId, message, error);
      return {
        failed: true,
        result: await this.fail(
          state,
          message,
          input,
          permission.mode === "BLOCKED" ? "COMMAND_BLOCKED" : "COMMAND_PERMISSION_DENIED",
        ),
      };
    }

    const timeoutMs = commandInput.timeoutMs ?? this.commandRunner.defaultTimeoutMs;
    const cwd = await this.commandRunner.resolveCwd(commandInput.cwd);
    await this.eventStore.appendEvent(state.sessionId, {
      type: "COMMAND_STARTED",
      payload: {
        command,
        cwd,
        timeoutMs,
      },
    });

    const pendingOutputEvents: Array<Promise<void>> = [];
    const executed = await this.commandRunner.run({ ...commandInput, cwd, timeoutMs }, {
      onOutput: (event) => {
        pendingOutputEvents.push(this.emit({ type: "command_output", ...event }));
      },
    });
    const result: CommandResult = {
      ...executed,
      verification: classifyVerificationCommandInput(commandInput),
    };
    await Promise.all(pendingOutputEvents);
    state.addCommandResult(result);
    await this.recordCommandResult(state.sessionId, result);
    await this.emit({
      type: "command_result",
      command: result.command,
      success: result.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });

    if (!result.success) {
      const error = result.stderr || result.stdout || result.error || `Command failed with exit code ${String(result.exitCode)}`;
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      if (result.exitCode === null && !result.timedOut && result.verification?.level === "NONE") {
        const fallback = await this.executeBuiltInVerificationFallback(state, input, {
          reason: `The unclassified command failed (${error}).`,
          requireRepositoryChange: true,
        });
        if (fallback) return fallback;
      }
      return { failed: true };
    } else {
      state.setLastError(null);
    }

    return { failed: false };
  }

  private async executeBuiltInVerificationFallback(
    state: AgentState,
    input: AgentRunInput,
    options: {
      reason: string;
      preferredPath?: string;
      requireRepositoryChange: boolean;
    },
  ): Promise<StepOutcome | undefined> {
    const contract = buildTaskCompletionContract(state);
    if (contract.requiredVerificationLevel !== "SYNTAX") return undefined;
    if (options.requireRepositoryChange && !state.getCompletionEvidence().repositoryChanged) return undefined;

    const supportedPathPattern = /\.(?:html?|json|js|cjs)$/i;
    const candidates = options.preferredPath
      ? [options.preferredPath]
      : contract.targetFiles.filter((target) => supportedPathPattern.test(target));
    const paths = [...new Set(candidates.map((target) => target.replace(/^\.\//, "").replaceAll("\\", "/")))]
      .filter((target) => supportedPathPattern.test(target));
    if (paths.length !== 1) return undefined;

    const tool = this.availableTools.find((candidate) => candidate.name === "verify_file");
    if (!isToolAllowedByTaskContract(tool, state.taskContract)) return undefined;
    const targetPath = paths[0];
    if (!targetPath) return undefined;

    const message = [
      `VERIFIER_AUTO_FALLBACK: ${options.reason}`,
      `Running the safe built-in verify_file parser for ${targetPath}.`,
    ].join(" ");
    await this.emit({ type: "guardrail", code: "VERIFIER_AUTO_FALLBACK", message });
    const failed = await this.executeToolDecision(state, "verify_file", { path: targetPath }, input);
    return { failed };
  }

  private async executeAskUserDecision(
    state: AgentState,
    message: string,
    input: AgentRunInput,
  ): Promise<StepOutcome> {
    await this.emit({ type: "ask_user", message });

    if (input.nonInteractive || !this.askUser) {
      const error = "Agent asked for user input in non-interactive mode";
      state.status = "WAITING_USER";
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      return { failed: true, result: await this.fail(state, error, input, "USER_INPUT_REQUIRED") };
    }

    state.status = "WAITING_USER";
    const answer = await this.askUser(`${message}\n> `);
    state.status = "RUNNING";
    await this.recordUserMessage(state, answer);
    return { failed: false };
  }

  private async finish(
    state: AgentState,
    summary: string,
    success: boolean,
    input: AgentRunInput,
  ): Promise<AgentRunResult> {
    if (state.operatingMode === "PLAN") {
      state.markFinished("");
      await this.recordCheckpoint(state, "FINISHED");
      await this.sessionStore.appendRecord(state.sessionId, {
        type: "TASK_SUMMARY",
        payload: {
          summary,
          success,
          mode: "PLAN",
          goal: state.userGoal,
          steps: state.step,
        },
      });
      await this.eventStore.appendEvent(state.sessionId, {
        type: "TASK_FINISHED",
        payload: { summary, success, mode: "PLAN", steps: state.step },
      });
      if (input.keepSessionActive !== true) {
        await this.sessionStore.updateSessionStatus(state.sessionId, success ? "FINISHED" : "FAILED");
      }
      await this.emit({ type: "summary", summary, success });
      return {
        sessionId: state.sessionId,
        success,
        summary,
        finalDiff: "",
        steps: state.step,
        taskKind: state.taskContract.kind,
        outputKind: state.taskContract.outputKind,
        resultMode: state.taskContract.resultMode,
        ...collaborationResultMetadata(state),
      };
    }

    const finalDiff = state.taskContract.capabilities.repositoryWrite ? await this.readFinalDiff(state) : "";
    state.markFinished(finalDiff);
    await this.recordCheckpoint(state, "FINISHED");
    if (state.taskContract.capabilities.repositoryWrite) {
      await this.sessionStore.appendRecord(state.sessionId, {
        type: "DIFF_SUMMARY",
        payload: {
          length: finalDiff.length,
          ...taskDiffRecordMetadata(this.activeTaskDiffArtifact),
        },
      });
      await this.eventStore.appendEvent(state.sessionId, {
        type: "DIFF_GENERATED",
        payload: {
          truncated: false,
          length: finalDiff.length,
        },
      });
      await this.emit({ type: "diff", generated: true });
    } else {
      await this.recordAssistantResponse(state.sessionId, summary);
    }

    await this.sessionStore.appendRecord(state.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary,
        success,
        mode: state.taskContract.resultMode,
        executionEngine: "AGENT_LOOP",
        taskKind: state.taskContract.kind,
        outputKind: state.taskContract.outputKind,
        resultMode: state.taskContract.resultMode,
        ...taskDiffRecordMetadata(this.activeTaskDiffArtifact),
        steps: state.step,
      },
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "TASK_FINISHED",
      payload: {
        summary,
        success,
        steps: state.step,
        mode: state.taskContract.resultMode,
        executionEngine: "AGENT_LOOP",
        taskKind: state.taskContract.kind,
        outputKind: state.taskContract.outputKind,
      },
    });
    if (input.keepSessionActive !== true) {
      await this.sessionStore.updateSessionStatus(state.sessionId, success ? "FINISHED" : "FAILED");
    }
    await this.emit({ type: "summary", summary, success });

    return {
      sessionId: state.sessionId,
      success,
      summary,
      finalDiff,
      steps: state.step,
      taskKind: state.taskContract.kind,
      outputKind: state.taskContract.outputKind,
      resultMode: state.taskContract.resultMode,
      ...taskDiffResultMetadata(this.activeTaskDiffArtifact),
      ...collaborationResultMetadata(state),
    };
  }

  private async fail(
    state: AgentState,
    error: string,
    input?: AgentRunInput,
    failureCode = "UNKNOWN_FAILURE",
  ): Promise<AgentRunResult> {
    state.markFailed(error);
    const finalDiff = state.operatingMode === "PLAN" || !state.taskContract.capabilities.repositoryWrite
      ? ""
      : await this.readFinalDiff(state);
    state.finalDiff = finalDiff;
    await this.recordCheckpoint(state, "FAILED");

    if (state.operatingMode !== "PLAN" && state.taskContract.capabilities.repositoryWrite) {
      await this.sessionStore.appendRecord(state.sessionId, {
        type: "DIFF_SUMMARY",
        payload: {
          length: finalDiff.length,
          failed: true,
          ...taskDiffRecordMetadata(this.activeTaskDiffArtifact),
        },
      });
    }
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: error,
        success: false,
        mode: state.operatingMode === "PLAN" ? "PLAN" : state.taskContract.resultMode,
        executionEngine: "AGENT_LOOP",
        taskKind: state.taskContract.kind,
        outputKind: state.taskContract.outputKind,
        ...taskDiffRecordMetadata(this.activeTaskDiffArtifact),
        steps: state.step,
      },
    });

    await this.eventStore.appendEvent(state.sessionId, {
      type: "TASK_FAILED",
      payload: {
        error,
        failureCode,
        steps: state.step,
      },
    });
    if (input?.keepSessionActive !== true) {
      await this.sessionStore.updateSessionStatus(state.sessionId, "FAILED");
    }
    await this.emit({ type: "error", code: failureCode, message: error });

    return {
      sessionId: state.sessionId,
      success: false,
      summary: error,
      finalDiff,
      steps: state.step,
      error,
      failureCode,
      taskKind: state.taskContract.kind,
      outputKind: state.taskContract.outputKind,
      resultMode: state.taskContract.resultMode,
      ...taskDiffResultMetadata(this.activeTaskDiffArtifact),
      ...collaborationResultMetadata(state),
    };
  }

  private buildToolContext(sessionId: string, input: AgentRunInput): ToolContext {
    return {
      repoPath: this.repoPath,
      sessionId,
      sessionStore: this.sessionStore,
      eventStore: this.eventStore,
      permissionManager: this.permissionManager,
      ...(input.autoApprove === undefined ? {} : { autoApprove: input.autoApprove }),
      ...(input.nonInteractive === undefined ? {} : { nonInteractive: input.nonInteractive }),
    };
  }

  private async ensureSession(
    userGoal: string,
    sessionId: string | undefined,
    operatingMode: AgentOperatingMode,
  ): Promise<string> {
    if (sessionId) {
      await this.sessionStore.ensureSession(sessionId);
      await this.sessionStore.updateOperatingMode(sessionId, operatingMode);
      await this.eventStore.init();
      return sessionId;
    }

    const created = await this.sessionStore.createSession({ title: userGoal.slice(0, 80), operatingMode });
    await this.eventStore.appendEvent(created.sessionId, {
      type: "SESSION_CREATED",
      payload: {
        title: created.title,
        repoPath: created.repoPath,
        baseCommit: created.baseCommit,
      },
    });

    return created.sessionId;
  }

  private async readDecision(
    state: AgentState,
    userGoal: string,
    context: string,
    availableTools: ToolSpec[],
    conversation: ConversationMessage[] | undefined,
    originalUserGoal: string,
    conversationHistoryTruncated: boolean,
    finalOnly: boolean,
  ): Promise<AgentDecision> {
    const mode = "agent_decision";
    const startedAt = Date.now();
    await this.eventStore.appendEvent(state.sessionId, {
      type: "LLM_CALL_STARTED",
      payload: { mode, step: state.step },
    });
    await this.emit({ type: "llm", phase: "started", mode });
    try {
      const decision = await this.llmClient.chat({
        userGoal,
        context,
        state: state.toSnapshot(),
        availableTools,
        ...(finalOnly ? { decisionConstraint: "FINAL_ONLY" as const } : {}),
        ...(conversation && conversation.length > 0 ? { conversation } : {}),
      });
      await this.recordLlmUsage(state, drainLlmCallMetrics(this.llmClient), mode, Date.now() - startedAt);
      if (decision.type !== "FINAL") return decision;
      const conversationSafeSummary = await this.correctPriorResponseDenial(
        state,
        originalUserGoal,
        decision.summary,
        conversation ?? [],
        conversationHistoryTruncated,
      );
      return {
        ...decision,
        summary: await this.correctCapabilityClaim(state, originalUserGoal, conversationSafeSummary),
      };
    } catch (error) {
      const message = `LLM decision failed: ${errorToMessage(error)}`;
      const durationMs = Date.now() - startedAt;
      await this.eventStore.appendEvent(state.sessionId, {
        type: "LLM_CALL_FAILED",
        payload: { mode, step: state.step, durationMs, error: message },
      });
      await this.emit({ type: "llm", phase: "failed", mode, durationMs, error: message });
      state.setLastError(message);
      await this.recordError(state.sessionId, message, error);
      return { type: "FAILED", error: message };
    }
  }

  private async correctPriorResponseDenial(
    state: AgentState,
    userGoal: string,
    text: string,
    conversation: ConversationMessage[],
    historyTruncated: boolean,
  ): Promise<string> {
    const violation = inspectPriorResponseConsistency(
      userGoal,
      text,
      conversation,
      priorResponseGuardOptions(state, historyTruncated),
    );
    if (!violation) return text;
    return await this.recordPriorResponseFallback(state, userGoal, violation);
  }

  private async recordPriorResponseFallback(
    state: AgentState,
    userGoal: string,
    violation: PriorResponseConsistencyViolation,
  ): Promise<string> {
    const message = "A model denial conflicted with the visible conversation record and was replaced by a record-grounded correction.";
    await this.eventStore.appendEvent(state.sessionId, {
      type: "PRIOR_RESPONSE_DENIAL_CORRECTED",
      payload: {
        code: violation.code,
        matchedTerms: violation.matchedTerms,
        excerpt: violation.excerpt ?? null,
        message,
      },
    });
    await this.emit({ type: "guardrail", code: "PRIOR_RESPONSE_DENIAL_CORRECTED", message });
    return renderPriorResponseSafeFallback(violation, inferPriorResponseLocale(userGoal));
  }

  private async correctCapabilityClaim(
    state: AgentState,
    userGoal: string,
    text: string,
  ): Promise<string> {
    const correction = enforceCapabilityTruth({
      ...(state.taskContract.taskFrame
        ? { taskFrame: state.taskContract.taskFrame }
        : {}),
      userGoal,
      answer: text,
    });
    if (!correction.corrected) return text;
    const capabilities = correction.capabilities.length > 0
      ? correction.capabilities.join(",")
      : "ALL";
    const message = `Product capability answer was grounded in the local Capability Registry (${capabilities}).`;
    await this.eventStore.appendEvent(state.sessionId, {
      type: "CAPABILITY_CLAIM_CORRECTED",
      payload: { capabilities: correction.capabilities, message },
    });
    await this.emit({ type: "guardrail", code: "CAPABILITY_CLAIM_CORRECTED", message });
    return correction.text;
  }

  private async recordAssistantResponse(sessionId: string, content: string): Promise<void> {
    await this.sessionStore.appendRecord(sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content },
    });
    await this.eventStore.appendEvent(sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content },
    });
  }

  private async recordUserMessage(state: AgentState, content: string): Promise<void> {
    state.addUserMessage(content);
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "USER_MESSAGE",
      payload: { content, runId: state.runId },
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "USER_MESSAGE",
      payload: { content, runId: state.runId },
    });
  }

  private async recordDecision(sessionId: string, decision: AgentDecision): Promise<void> {
    await this.sessionStore.appendRecord(sessionId, {
      type: "AGENT_DECISION",
      payload: {
        decision: toJsonValue(decision),
      },
    });
  }

  private async recordDecisionCheckpoint(state: AgentState, decision: AgentDecision): Promise<void> {
    if (decision.type === "ASK_USER") {
      await this.recordCheckpoint(state, "WAITING_USER");
      return;
    }
    if (decision.type === "TOOL_CALL") {
      await this.recordCheckpoint(state, "RUNNING", `tool:${decision.toolName}`);
      return;
    }
    if (decision.type === "DELEGATE") {
      await this.recordCheckpoint(state, "RUNNING", `delegation:${decision.reason}`);
      return;
    }
    if (decision.type === "APPLY_DELEGATED_PATCH") {
      await this.recordCheckpoint(state, "RUNNING", `delegated-patch:${decision.taskId}`);
      return;
    }
    if (decision.type === "APPLY_PATCH") {
      await this.recordCheckpoint(state, "RUNNING", `patch:${decision.description}`);
      return;
    }
    if (decision.type === "RUN_COMMAND") {
      await this.recordCheckpoint(state, "RUNNING", `command:${decision.description}`);
    }
  }

  private async recordCheckpoint(
    state: AgentState,
    status: "RUNNING" | "WAITING_USER" | "FINISHED" | "FAILED" = state.status,
    inFlightAction?: string,
  ): Promise<void> {
    const checkpoint = createAgentCheckpoint({
      state,
      status,
      ...(inFlightAction ? { inFlightAction } : {}),
    });
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "AGENT_CHECKPOINT",
      payload: checkpointToPayload(checkpoint),
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "AGENT_CHECKPOINTED",
      payload: {
        version: checkpoint.version,
        runId: checkpoint.runId,
        status: checkpoint.status,
        completedSteps: checkpoint.completedSteps,
        totalSteps: checkpoint.totalSteps,
        modifiedFileCount: checkpoint.workingSet.modifiedFiles.length,
        successfulPatch: checkpoint.effects.successfulPatch,
        verificationAttemptedAfterPatch: checkpoint.effects.verificationAttemptedAfterPatch ?? false,
        verificationAfterPatch: checkpoint.effects.verificationAfterPatch ?? false,
        ...(checkpoint.inFlightAction ? { inFlightAction: checkpoint.inFlightAction } : {}),
      },
    });
  }

  private async recordCommandResult(sessionId: string, result: CommandResult): Promise<void> {
    await this.sessionStore.appendRecord(sessionId, {
      type: "COMMAND_RESULT",
      payload: commandResultToPayload(result),
    });
    await this.eventStore.appendEvent(sessionId, {
      type: "COMMAND_FINISHED",
      payload: {
        command: result.command,
        exitCode: result.exitCode,
        success: result.success,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
      },
    });

    if (result.verification?.level === "TEST") {
      await this.eventStore.appendEvent(sessionId, {
        type: result.success ? "TEST_PASSED" : "TEST_FAILED",
        payload: {
          command: result.command,
          exitCode: result.exitCode,
          stderrPreview: result.stderr.slice(0, 1000),
        },
      });
    }
  }

  private async recordSubAgentBatch(sessionId: string, batch: SubAgentBatchResult): Promise<void> {
    await this.sessionStore.appendRecord(sessionId, {
      type: "SUBAGENT_BATCH_RESULT",
      payload: toJsonObject(batch as unknown as Record<string, unknown>),
    });
    for (const result of batch.results) {
      await this.sessionStore.appendRecord(sessionId, {
        type: "LLM_USAGE",
        payload: toJsonObject({
          mode: `subagent:${result.role}`,
          taskId: result.taskId,
          llmCalls: result.usage.llmCalls,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          cachedPromptTokens: result.usage.cachedPromptTokens,
          reasoningTokens: result.usage.reasoningTokens,
          usageAvailable: result.usage.usageAvailable,
        }),
      });
    }
    await this.eventStore.appendEvent(sessionId, {
      type: batch.status === "FAILED" ? "SUBAGENT_BATCH_FAILED" : "SUBAGENT_BATCH_FINISHED",
      payload: {
        batchId: batch.batchId,
        status: batch.status,
        taskCount: batch.results.length,
        completedCount: batch.results.filter((result) => result.status === "COMPLETED").length,
        maxParallelAgents: batch.maxParallelAgents,
        durationMs: batch.durationMs,
        llmCalls: batch.usage.llmCalls,
        totalTokens: batch.usage.totalTokens,
        cachedPromptTokens: batch.usage.cachedPromptTokens,
        reasoningTokens: batch.usage.reasoningTokens,
        usageAvailable: batch.usage.usageAvailable,
      },
    });
    await this.emit({
      type: "llm",
      phase: "finished",
      mode: "subagents",
      calls: batch.usage.llmCalls,
      durationMs: batch.durationMs,
      usage: {
        usageAvailable: batch.usage.usageAvailable,
        promptTokens: batch.usage.promptTokens,
        completionTokens: batch.usage.completionTokens,
        totalTokens: batch.usage.totalTokens,
        reasoningTokens: batch.usage.reasoningTokens,
        cacheReadTokens: batch.usage.cachedPromptTokens,
      },
    });
  }

  private async recordError(sessionId: string, message: string | null, error?: unknown): Promise<void> {
    if (!message) {
      return;
    }

    await this.sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: {
        message,
        code: error ? errorToCode(error, "AGENT_ERROR") : "AGENT_ERROR",
        details: error ? toJsonValue(errorToDetails(error)) : null,
      },
    });
  }

  private async recordLlmUsage(
    state: AgentState,
    metrics: LlmCallMetrics[],
    mode: string,
    durationMs: number,
  ): Promise<void> {
    for (const metric of metrics) {
      await this.sessionStore.appendRecord(state.sessionId, {
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
          cacheWriteTokens: metric.usage?.cacheWriteTokens ?? null,
          reasoningTokens: metric.usage?.reasoningTokens ?? null,
          reasoningContentAvailable: metric.reasoningContentAvailable === true,
        }),
      });
    }
    const aggregate = aggregateLlmMetrics(metrics);
    await this.eventStore.appendEvent(state.sessionId, {
      type: "LLM_CALL_FINISHED",
      payload: toJsonObject({
        mode,
        step: state.step,
        calls: metrics.length || 1,
        durationMs,
        model: aggregate.model ?? null,
        finishReason: aggregate.finishReason ?? null,
        ...aggregate.usage,
      }),
    });
    await this.emit({
      type: "llm",
      phase: "finished",
      mode,
      calls: metrics.length || 1,
      durationMs,
      ...(aggregate.model ? { model: aggregate.model } : {}),
      ...(aggregate.finishReason ? { finishReason: aggregate.finishReason } : {}),
      usage: aggregate.usage,
    });
  }

  private async readFinalDiff(state: AgentState): Promise<string> {
    if (this.activeTaskDiffBaseline) {
      const service = new TaskDiffService({ repoPath: this.repoPath });
      const after = await service.captureWorkingTree().catch(() => undefined);
      if (after) {
        const artifact = await service.createArtifact(
          state.sessionId,
          this.activeTaskDiffBaseline,
          after,
        ).catch(() => undefined);
        if (artifact) {
          await this.persistTaskDiffArtifact(state, artifact).catch(() => undefined);
          return artifact.unifiedDiff;
        }
      }
    }
    return state.patchResults
      .filter((result) => result.result.success)
      .map((result) => result.patch.trim())
      .filter(Boolean)
      .join("\n");
  }

  private async persistTaskDiffArtifact(state: AgentState, artifact: TaskDiffArtifact): Promise<void> {
    if (artifact.fileCount === 0 || this.activeTaskDiffArtifact) return;
    await new TaskDiffStore(this.repoPath).save(artifact);
    this.activeTaskDiffArtifact = artifact;
    const metadata = taskDiffRecordMetadata(artifact);
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "TASK_DIFF",
      payload: toJsonObject(metadata),
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "CHANGES_READY",
      payload: toJsonObject(metadata),
    });
  }

  private async emit(event: AgentProgressEvent): Promise<void> {
    const state = this.activeState;
    const enriched = {
      ...event,
      version: 1 as const,
      timestamp: new Date().toISOString(),
      sequence: ++this.progressSequence,
      ...(state ? { sessionId: state.sessionId, runId: state.runId, step: state.step } : {}),
    } as AgentProgressEvent;
    await this.onProgress?.(enriched);
  }
}

function completionProgressFingerprint(state: AgentState): string {
  const evidence = state.getCompletionEvidence();
  return JSON.stringify({
    successfulPatches: state.patchResults.filter((result) => result.result.success).length,
    successfulTools: state.toolResults.filter((result) => result.result.success).length,
    verificationEvidence: evidence.verificationEvidence.map((result) => [
      result.command,
      result.success,
      result.level,
    ]),
    fileReadCoverage: state.getFileReadCoverage().map((entry) => [entry.path, entry.complete, entry.readCalls]),
    delegationBatches: state.delegationBatches.length,
  });
}
