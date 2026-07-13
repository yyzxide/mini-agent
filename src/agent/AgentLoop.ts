import { CommandRunner, isHighRiskCommandInput } from "../command/CommandRunner.js";
import type { CommandInput, CommandResult } from "../command/CommandRunner.js";
import { isTestCommand } from "../command/CommandClassification.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { GitManager } from "../git/GitManager.js";
import type { LlmClient, ToolSpec } from "../llm/LlmClient.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import type { JsonObject } from "../session/SessionTypes.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/Tool.js";
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
}

export interface AgentRunResult {
  sessionId: string;
  success: boolean;
  summary: string;
  finalDiff: string;
  steps: number;
  error?: string;
}

export type AgentProgressEvent =
  | { type: "session"; sessionId: string }
  | { type: "plan"; message: string }
  | { type: "tool"; toolName: string; input: JsonObject }
  | { type: "patch"; description: string }
  | { type: "command"; command: string }
  | { type: "ask_user"; message: string }
  | { type: "diff"; generated: boolean }
  | { type: "summary"; summary: string; success: boolean }
  | { type: "error"; message: string };

export type AgentProgressHandler = (event: AgentProgressEvent) => void | Promise<void>;

interface StepOutcome {
  result?: AgentRunResult;
  failed: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REPEATED_DECISIONS = 3;

export class AgentLoop {
  private readonly repoPath: string;
  private readonly llmClient: LlmClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly eventStore: EventStore;
  private readonly commandRunner: CommandRunner;
  private readonly permissionManager: PermissionManager;
  private readonly patchManager: PatchManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly onProgress: AgentProgressHandler | undefined;
  private readonly askUser: ((message: string) => Promise<string>) | undefined;
  private readonly availableTools: ToolSpec[];

  constructor(options: AgentLoopOptions) {
    this.repoPath = options.repoPath;
    this.llmClient = options.llmClient;
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.eventStore = options.eventStore;
    this.commandRunner = options.commandRunner ?? new CommandRunner({ repoPath: options.repoPath });
    this.permissionManager = options.permissionManager ?? new PermissionManager();
    this.patchManager = options.patchManager ?? new PatchManager({ repoPath: options.repoPath });
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder({ repoPath: options.repoPath });
    this.onProgress = options.onProgress;
    this.askUser = options.askUser;
    this.availableTools = this.toolRegistry.listSpecs();
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const userGoal = input.userGoal.trim();
    const originalUserGoal = input.originalUserGoal?.trim() || userGoal;
    if (userGoal.length === 0) {
      throw new Error("User goal cannot be empty");
    }

    const operatingMode = input.operatingMode ?? "EXECUTE";
    const sessionId = await this.ensureSession(originalUserGoal, input.sessionId, operatingMode);
    await this.emit({ type: "session", sessionId });

    const state = new AgentState({
      sessionId,
      repoPath: this.repoPath,
      userGoal,
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      operatingMode,
    });

    await this.recordUserMessage(state, originalUserGoal);
    let consecutiveFailures = 0;
    let previousDecisionKey: string | undefined;
    let repeatedDecisionCount = 0;

    while (!state.isStepLimitReached()) {
      const availableTools = selectToolsForOperatingMode(this.availableTools, state.operatingMode);
      const context = await this.contextBuilder.build(state, availableTools);
      const decision = await this.readDecision(state, userGoal, context, availableTools);

      state.addDecision(decision);
      await this.recordDecision(state.sessionId, decision);
      await this.recordAssistantMessage(state, decisionToMessage(decision));

      const decisionKey = stableDecisionKey(decision);
      if (decisionKey === previousDecisionKey) {
        repeatedDecisionCount += 1;
      } else {
        repeatedDecisionCount = 1;
        previousDecisionKey = decisionKey;
      }

      if (repeatedDecisionCount > MAX_REPEATED_DECISIONS) {
        const error = "Agent repeated the same decision too many times";
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input);
      }

      const outcome = await this.handleDecision(state, decision, input);
      if (outcome.result) {
        return outcome.result;
      }

      consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        const error = "Agent failed too many consecutive steps";
        await this.recordError(state.sessionId, error);
        return await this.fail(state, error, input);
      }

      state.incrementStep();
    }

    const error = `Agent stopped after reaching max steps (${state.maxSteps})`;
    await this.recordError(sessionId, error);
    return await this.fail(state, error, input);
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
      return { failed: true };
    }

    switch (decision.type) {
      case "PLAN":
        await this.emit({ type: "plan", message: decision.message });
        return { failed: false };

      case "TOOL_CALL":
        return { failed: await this.executeToolDecision(state, decision.toolName, decision.input, input) };

      case "APPLY_PATCH":
        return await this.executePatchDecision(state, decision, input);

      case "RUN_COMMAND":
        return await this.executeCommandDecision(state, decision, input);

      case "ASK_USER":
        return await this.guardDecisionThenContinue(state, decision)
          ?? await this.executeAskUserDecision(state, decision.message, input);

      case "FINAL":
        return await this.guardDecisionThenContinue(state, decision)
          ?? { failed: false, result: await this.finish(state, decision.summary, decision.success, input) };

      case "FAILED":
        return { failed: true, result: await this.fail(state, decision.error, input) };
    }
  }

  private validatePlanModeDecision(state: AgentState, decision: AgentDecision): string | undefined {
    if (state.operatingMode !== "PLAN") {
      return undefined;
    }

    if (decision.type === "APPLY_PATCH" || decision.type === "RUN_COMMAND") {
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
    return { failed: true };
  }

  private async executeToolDecision(
    state: AgentState,
    toolName: string,
    toolInput: JsonObject,
    input: AgentRunInput,
  ): Promise<boolean> {
    await this.emit({ type: "tool", toolName, input: toolInput });
    const result = await this.toolRegistry.execute(toolName, toolInput, this.buildToolContext(state.sessionId, input));

    state.addToolResult({
      toolName,
      input: toolInput,
      result,
    });

    if (!result.success) {
      state.setLastError(result.error?.message ?? `Tool failed: ${toolName}`);
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
    const result = await this.toolRegistry.execute(
      "apply_patch",
      { patch: decision.patch, checkBeforeApply: true },
      this.buildToolContext(state.sessionId, input),
    );

    state.addPatchResult({
      patch: decision.patch,
      ...(decision.description ? { description: decision.description } : {}),
      result,
    });

    if (!result.success) {
      const error = result.error?.message ?? "Patch application failed";
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      if (result.error?.code === "PATCH_PERMISSION_DENIED") {
        return { failed: true, result: await this.fail(state, error, input) };
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
    const isHighRiskCommand = isHighRiskCommandInput(commandInput);
    await this.emit({ type: "command", command });

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
      return { failed: true, result: await this.fail(state, message, input) };
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

    const result = await this.commandRunner.run({ ...commandInput, cwd, timeoutMs });
    state.addCommandResult(result);
    await this.recordCommandResult(state.sessionId, result);

    if (!result.success) {
      const error = result.stderr || result.stdout || result.error || `Command failed with exit code ${String(result.exitCode)}`;
      state.setLastError(error);
      await this.recordError(state.sessionId, error);
      return { failed: true };
    } else {
      state.setLastError(null);
    }

    return { failed: false };
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
      return { failed: true, result: await this.fail(state, error, input) };
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
      return { sessionId: state.sessionId, success, summary, finalDiff: "", steps: state.step };
    }

    const finalDiff = await this.readFinalDiff();
    state.markFinished(finalDiff);
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "DIFF_SUMMARY",
      payload: {
        diff: finalDiff,
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

    await this.sessionStore.appendRecord(state.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary,
        success,
        mode: "AGENT_LOOP",
        finalDiff,
        steps: state.step,
      },
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "TASK_FINISHED",
      payload: {
        summary,
        success,
        steps: state.step,
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
    };
  }

  private async fail(state: AgentState, error: string, input?: AgentRunInput): Promise<AgentRunResult> {
    state.markFailed(error);
    const finalDiff = state.operatingMode === "PLAN" ? "" : await this.readFinalDiff();
    state.finalDiff = finalDiff;

    if (state.operatingMode !== "PLAN") {
      await this.sessionStore.appendRecord(state.sessionId, {
        type: "DIFF_SUMMARY",
        payload: { diff: finalDiff, failed: true },
      });
    }
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: error,
        success: false,
        mode: state.operatingMode === "PLAN" ? "PLAN" : "AGENT_LOOP",
        finalDiff,
        steps: state.step,
      },
    });

    await this.eventStore.appendEvent(state.sessionId, {
      type: "TASK_FAILED",
      payload: {
        error,
        steps: state.step,
      },
    });
    if (input?.keepSessionActive !== true) {
      await this.sessionStore.updateSessionStatus(state.sessionId, "FAILED");
    }
    await this.emit({ type: "error", message: error });

    return {
      sessionId: state.sessionId,
      success: false,
      summary: error,
      finalDiff,
      steps: state.step,
      error,
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
  ): Promise<AgentDecision> {
    try {
      const decision = await this.llmClient.chat({
        userGoal,
        context,
        state: state.toSnapshot(),
        availableTools,
      });
      await this.recordLlmUsage(state.sessionId, drainLlmCallMetrics(this.llmClient), "agent_decision");
      return decision;
    } catch (error) {
      const message = `LLM decision failed: ${errorToMessage(error)}`;
      state.setLastError(message);
      await this.recordError(state.sessionId, message, error);
      return { type: "FAILED", error: message };
    }
  }

  private async recordUserMessage(state: AgentState, content: string): Promise<void> {
    state.addUserMessage(content);
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "USER_MESSAGE",
      payload: { content },
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "USER_MESSAGE",
      payload: { content },
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

  private async recordAssistantMessage(state: AgentState, content: string): Promise<void> {
    state.addAssistantMessage(content);
    await this.sessionStore.appendRecord(state.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content },
    });
    await this.eventStore.appendEvent(state.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content },
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

    if (isTestCommand(result.command)) {
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

  private async recordLlmUsage(sessionId: string, metrics: LlmCallMetrics[], mode: string): Promise<void> {
    for (const metric of metrics) {
      await this.sessionStore.appendRecord(sessionId, {
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

  private async readFinalDiff(): Promise<string> {
    const result = await this.patchManager.getDiff().catch(async () => {
      const git = new GitManager({ repoPath: this.repoPath });
      return await git.getDiff();
    });
    return result.diff;
  }

  private async emit(event: AgentProgressEvent): Promise<void> {
    await this.onProgress?.(event);
  }
}

function drainLlmCallMetrics(client: LlmClient): LlmCallMetrics[] {
  if (typeof (client as { drainCallMetrics?: unknown }).drainCallMetrics === "function") {
    return ((client as unknown as { drainCallMetrics: () => LlmCallMetrics[] }).drainCallMetrics());
  }

  return [];
}

function commandResultToPayload(result: CommandResult): JsonObject {
  return toJsonObject({
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    success: result.success,
    timedOut: result.timedOut,
    truncated: result.truncated,
    error: result.error,
  });
}

function commandInputFromDecision(decision: Extract<AgentDecision, { type: "RUN_COMMAND" }>): CommandInput {
  if (decision.shell) {
    return {
      command: decision.command ?? "",
      shell: true,
      ...(decision.cwd ? { cwd: decision.cwd } : {}),
      ...(decision.timeoutMs === undefined ? {} : { timeoutMs: decision.timeoutMs }),
    };
  }

  return {
    executable: decision.executable ?? "",
    args: decision.args ?? [],
    shell: false,
    ...(decision.cwd ? { cwd: decision.cwd } : {}),
    ...(decision.timeoutMs === undefined ? {} : { timeoutMs: decision.timeoutMs }),
  };
}

function renderCommandInput(input: CommandInput): string {
  if (input.shell) {
    return input.command ?? "";
  }

  return [input.executable ?? "", ...(input.args ?? [])].map(quoteCommandPart).join(" ").trim();
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isGitDiffData(value: unknown): value is { diff: string } {
  return typeof value === "object"
    && value !== null
    && "diff" in value
    && typeof value.diff === "string";
}

function stableDecisionKey(decision: AgentDecision): string {
  return JSON.stringify(sortJsonValue(decision));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }

  return value;
}
