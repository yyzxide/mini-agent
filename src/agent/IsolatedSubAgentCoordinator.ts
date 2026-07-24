import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentState } from "./AgentState.js";
import type { AgentDecision } from "./AgentDecision.js";
import { PatchManager } from "../patch/PatchManager.js";
import { CommandRunner, isHighRiskCommandInput, type CommandInput } from "../command/CommandRunner.js";
import { selectToolsForOperatingMode } from "./AgentOperatingMode.js";
import type {
  MultiAgentPolicy,
  SubAgentBatchInput,
  SubAgentBatchResult,
  SubAgentCoordinator,
  SubAgentEvidenceRef,
  SubAgentIdentity,
  SubAgentResult,
  SubAgentTask,
  SubAgentUsage,
} from "./SubAgentTypes.js";
import { normalizeSubAgentTask } from "./SubAgentTypes.js";
import type { LlmClient, ToolSpec } from "../llm/LlmClient.js";
import type { LlmCallMetrics } from "../llm/OpenAICompatibleClient.js";
import { createDefaultToolRegistry, type ToolRegistry } from "../tools/ToolRegistry.js";
import { fingerprintWorkingTree, SubAgentWorktree } from "./SubAgentWorktree.js";

export interface IsolatedSubAgentCoordinatorOptions {
  repoPath: string;
  createLlmClient: (identity: SubAgentIdentity) => Promise<LlmClient> | LlmClient;
  createToolRegistry?: () => ToolRegistry;
}

export class IsolatedSubAgentCoordinator implements SubAgentCoordinator {
  private readonly repoPath: string;
  private readonly createLlmClient: IsolatedSubAgentCoordinatorOptions["createLlmClient"];
  private readonly createToolRegistry: () => ToolRegistry;

  constructor(options: IsolatedSubAgentCoordinatorOptions) {
    this.repoPath = options.repoPath;
    this.createLlmClient = options.createLlmClient;
    this.createToolRegistry = options.createToolRegistry ?? createDefaultToolRegistry;
  }

  async runBatch(input: SubAgentBatchInput): Promise<SubAgentBatchResult> {
    if (input.tasks.length < 1 || input.tasks.length > Math.min(3, input.policy.maxTasksPerRun)) {
      throw new Error("Delegation requires 1-3 tasks within the configured child-task budget.");
    }
    const startedAt = Date.now();
    const batchId = randomUUID();
    const ledger = new SubAgentBudgetLedger(input.policy);
    const tasks = input.tasks.map(normalizeSubAgentTask);
    const resultsById = new Map<string, SubAgentResult>();
    const pending = new Map(tasks.map((task) => [task.id, task]));
    let maxParallelAgents = 0;

    while (pending.size > 0) {
      for (const task of [...pending.values()]) {
        const failedDependency = task.dependsOn
          .map((id) => resultsById.get(id))
          .find((result) => result && result.status !== "COMPLETED");
        if (!failedDependency) continue;
        resultsById.set(task.id, failedResult(
          task,
          "FAILED",
          `Dependency ${failedDependency.taskId} did not complete successfully.`,
          emptyUsage(),
          [],
          [],
        ));
        pending.delete(task.id);
      }

      const ready = [...pending.values()].filter((task) => (
        task.dependsOn.every((id) => resultsById.get(id)?.status === "COMPLETED")
      ));
      if (ready.length === 0) {
        for (const task of pending.values()) {
          resultsById.set(task.id, failedResult(
            task,
            "PROTOCOL_VIOLATION",
            "Delegation dependency graph contains a cycle or an unresolved dependency.",
            emptyUsage(),
            [],
            [],
          ));
        }
        pending.clear();
        break;
      }

      const wave = ready.slice(0, Math.max(1, input.policy.maxConcurrency));
      maxParallelAgents = Math.max(maxParallelAgents, wave.length);
      const waveResults = await Promise.all(wave.map(async (task) => {
        await input.onProgress?.({
          phase: "task_started",
          taskId: task.id,
          role: task.role,
          access: task.access,
          dependsOn: task.dependsOn,
        });
        const result = await this.runTask({
            parentRunId: input.parentRunId,
            batchId,
            originalGoal: input.originalGoal,
            task,
            policy: input.policy,
            ledger,
            dependencies: task.dependsOn
              .map((id) => resultsById.get(id))
              .filter((result): result is SubAgentResult => result !== undefined),
            onProgress: input.onProgress,
          })
        await input.onProgress?.({
          phase: "task_finished",
          taskId: task.id,
          role: task.role,
          access: task.access,
          status: result.status,
          ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
          toolsCalled: result.toolsCalled,
          ...(result.error ? { error: result.error } : {}),
        });
        return result;
      }));
      wave.forEach((task, index) => {
        const result = waveResults[index];
        if (result) resultsById.set(task.id, result);
        pending.delete(task.id);
      });
    }

    const stableResults = tasks
      .map((task) => resultsById.get(task.id))
      .filter((result): result is SubAgentResult => result !== undefined);
    const completed = stableResults.filter((result) => result.status === "COMPLETED").length;
    return {
      batchId,
      status: completed === stableResults.length ? "COMPLETED" : completed > 0 ? "PARTIAL" : "FAILED",
      results: stableResults,
      usage: sumUsage(stableResults.map((result) => result.usage)),
      maxParallelAgents,
      durationMs: Date.now() - startedAt,
    };
  }

  private async runTask(input: {
    parentRunId: string;
    batchId: string;
    originalGoal: string;
    task: SubAgentTask;
    policy: MultiAgentPolicy;
    ledger: SubAgentBudgetLedger;
    dependencies: SubAgentResult[];
    onProgress: SubAgentBatchInput["onProgress"];
  }): Promise<SubAgentResult> {
    const identity: SubAgentIdentity = {
      agentId: `${input.parentRunId}:${input.task.id}`,
      parentRunId: input.parentRunId,
      batchId: input.batchId,
      taskId: input.task.id,
      role: input.task.role,
    };
    let worktree: SubAgentWorktree | undefined;
    let state: AgentState | undefined;
    let registry: ToolRegistry | undefined;
    const toolsCalled: string[] = [];
    const evidence: SubAgentEvidenceRef[] = [];
    const usage = emptyUsage();
    const changedFiles = new Set<string>();
    const verification: NonNullable<SubAgentResult["verification"]> = [];
    let protocolRecoveries = 0;

    try {
      worktree = await SubAgentWorktree.create({
        repoPath: this.repoPath,
        dependencyPatches: input.dependencies
          .map((result) => result.proposedPatch)
          .filter((patch): patch is string => typeof patch === "string" && patch.length > 0),
      });
      await input.onProgress?.({
        phase: "worktree_started",
        taskId: input.task.id,
        role: input.task.role,
        access: input.task.access,
        workspaceKind: worktree.snapshot.kind,
        baselineFingerprint: worktree.snapshot.baselineFingerprint,
      });
      state = new AgentState({
        sessionId: identity.agentId,
        runId: identity.agentId,
        repoPath: worktree.snapshot.repoPath,
        userGoal: buildDelegatedGoal(input.originalGoal, input.task, input.dependencies),
        maxSteps: input.policy.maxChildSteps,
        operatingMode: input.task.access === "PROPOSE_CHANGES" ? "EXECUTE" : "PLAN",
      });
      registry = this.createToolRegistry();
      const availableTools = selectSubAgentTools(registry.listSpecs());
      const client = await this.createLlmClient(identity);
      while (!state.isStepLimitReached()) {
        if (!input.ledger.tryConsumeLlmCall()) {
          return failedResult(input.task, "BUDGET_EXHAUSTED", "Shared child LLM-call budget exhausted.", usage, toolsCalled, evidence);
        }
        await input.onProgress?.({
          phase: "thinking",
          taskId: input.task.id,
          role: input.task.role,
          access: input.task.access,
          step: state.step + 1,
        });
        usage.llmCalls += 1;
        const decision = await client.chat({
          userGoal: state.userGoal,
          context: buildSubAgentContext(input.task, state, input.dependencies),
          state: state.toSnapshot(),
          availableTools,
        });
        addLlmMetrics(usage, drainLlmCallMetrics(client));
        await input.onProgress?.({
          phase: "decision",
          taskId: input.task.id,
          role: input.task.role,
          access: input.task.access,
          step: state.step + 1,
          decisionType: decision.type,
          message: summarizeChildDecision(decision),
        });
        if (
          decision.type === "FAILED"
          && isRecoverableChildProtocolFailure(decision.error)
          && protocolRecoveries < 2
        ) {
          protocolRecoveries += 1;
          const action = "Retry this child task with a shorter valid AgentDecision JSON response.";
          const recoveryMessage = `RECOVERABLE_CHILD_PROTOCOL_ERROR: ${decision.error} ${action}`;
          state.setLastError(recoveryMessage);
          state.addAssistantMessage(recoveryMessage);
          await input.onProgress?.({
            phase: "recovery",
            taskId: input.task.id,
            role: input.task.role,
            access: input.task.access,
            error: decision.error,
            action,
          });
          state.incrementStep();
          usage.steps = state.step;
          continue;
        }
        state.addDecision(decision);

        const terminal = await this.handleDecision({
          decision,
          task: input.task,
          state,
          registry,
          availableTools,
          ledger: input.ledger,
          usage,
          toolsCalled,
          evidence,
          maxResultChars: input.policy.maxResultChars,
          dependencies: input.dependencies,
          worktree,
          changedFiles,
          verification,
          onProgress: input.onProgress,
        });
        if (terminal) return terminal;
        state.incrementStep();
        usage.steps = state.step;
      }
      return failedResult(input.task, "BUDGET_EXHAUSTED", "Child step budget exhausted.", usage, toolsCalled, evidence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failedResult(input.task, "FAILED", message, usage, toolsCalled, evidence);
    } finally {
      await registry?.dispose();
      await worktree?.dispose();
    }
  }

  private async handleDecision(input: {
    decision: AgentDecision;
    task: SubAgentTask;
    state: AgentState;
    registry: ToolRegistry;
    availableTools: ToolSpec[];
    ledger: SubAgentBudgetLedger;
    usage: SubAgentUsage;
    toolsCalled: string[];
    evidence: SubAgentEvidenceRef[];
    maxResultChars: number;
    dependencies: SubAgentResult[];
    worktree: SubAgentWorktree;
    changedFiles: Set<string>;
    verification: NonNullable<SubAgentResult["verification"]>;
    onProgress: SubAgentBatchInput["onProgress"];
  }): Promise<SubAgentResult | undefined> {
    const { decision } = input;
    if (decision.type === "FINAL") {
      input.usage.steps = input.state.step;
      if (!decision.success) {
        return failedResult(input.task, "FAILED", decision.summary, input.usage, input.toolsCalled, input.evidence);
      }
      if (input.task.access === "PROPOSE_CHANGES") {
        const latestVerification = input.verification.at(-1);
        if (latestVerification && !latestVerification.success) {
          return failedResult(
            input.task,
            "FAILED",
            `Implementation child cannot finish after a failed verification command: ${latestVerification.command}`,
            input.usage,
            input.toolsCalled,
            input.evidence,
          );
        }
        const proposedPatch = await input.worktree.createPatch();
        if (!proposedPatch.trim()) {
          return failedResult(
            input.task,
            "FAILED",
            "Implementation child finished without making an isolated worktree change.",
            input.usage,
            input.toolsCalled,
            input.evidence,
          );
        }
        const preview = await new PatchManager({ repoPath: input.worktree.snapshot.repoPath })
          .previewPatch({ patch: proposedPatch });
        const parentFingerprint = await fingerprintWorkingTree(this.repoPath);
        const check = await new PatchManager({ repoPath: this.repoPath })
          .validatePatch({ patch: proposedPatch });
        if (!check.success) {
          const stale = parentFingerprint !== input.worktree.snapshot.baselineFingerprint;
          const error = [
            stale ? "Delegated patch conflicts with parent changes made after the child baseline." : "Delegated patch no longer applies cleanly to the parent worktree.",
            check.stderr ?? check.error ?? "git apply --check failed",
          ].join(" ");
          return {
            ...failedResult(input.task, "CONFLICT", error, input.usage, input.toolsCalled, input.evidence),
            baselineFingerprint: input.worktree.snapshot.baselineFingerprint,
            workspaceKind: input.worktree.snapshot.kind,
            verification: [...input.verification],
          };
        }
        return {
          taskId: input.task.id,
          role: input.task.role,
          objective: input.task.objective,
          status: "COMPLETED",
          summary: limitText(decision.summary, input.maxResultChars),
          evidence: uniqueEvidence(input.evidence),
          toolsCalled: [...input.toolsCalled],
          usage: { ...input.usage },
          proposedPatch,
          changedFiles: preview.files.map((file) => file.path),
          baselineFingerprint: input.worktree.snapshot.baselineFingerprint,
          workspaceKind: input.worktree.snapshot.kind,
          verification: [...input.verification],
        };
      }
      if (!input.state.toolResults.some((result) => result.result.success)) {
        return failedResult(
          input.task,
          "FAILED",
          "Child returned a report without successful repository tool evidence.",
          input.usage,
          input.toolsCalled,
          input.evidence,
        );
      }
      return {
        taskId: input.task.id,
        role: input.task.role,
        objective: input.task.objective,
        status: "COMPLETED",
        summary: limitText(decision.summary, input.maxResultChars),
        evidence: uniqueEvidence(input.evidence),
        toolsCalled: [...input.toolsCalled],
        usage: { ...input.usage },
        ...(input.task.access === "REVIEW_CHANGES"
          ? { reviewedTaskIds: input.dependencies.map((result) => result.taskId) }
          : {}),
        baselineFingerprint: input.worktree.snapshot.baselineFingerprint,
        workspaceKind: input.worktree.snapshot.kind,
      };
    }
    if (decision.type === "FAILED") {
      return failedResult(input.task, "FAILED", decision.error, input.usage, input.toolsCalled, input.evidence);
    }
    if (decision.type === "PLAN") {
      input.state.addAssistantMessage(decision.message);
      return undefined;
    }
    if (decision.type === "APPLY_PATCH" && input.task.access === "PROPOSE_CHANGES") {
      const patchManager = new PatchManager({ repoPath: input.worktree.snapshot.repoPath });
      const preview = await patchManager.previewPatch({ patch: decision.patch });
      const createsOnlyNewFiles = preview.files.length > 0
        && preview.files.every((file) => file.changeType === "ADDED");
      if (
        !createsOnlyNewFiles
        && !input.state.toolResults.some((result) => result.result.success)
      ) {
        return failedResult(
          input.task,
          "FAILED",
          "Implementation child proposed a patch without first inspecting repository evidence.",
          input.usage,
          input.toolsCalled,
          input.evidence,
        );
      }
      const applied = await patchManager.applyPatch({ patch: decision.patch, checkBeforeApply: true });
      if (!applied.success) {
        return failedResult(
          input.task,
          "FAILED",
          `Delegated worktree patch failed: ${applied.checkResult.stderr ?? applied.error ?? "invalid patch"}`,
          input.usage,
          input.toolsCalled,
          input.evidence,
        );
      }
      input.toolsCalled.push("apply_patch");
      preview.files.forEach((file) => input.changedFiles.add(file.path));
      input.state.setLastError(null);
      input.state.addAssistantMessage(`Applied isolated patch: ${decision.description}`);
      await input.onProgress?.({
        phase: "patch_applied",
        taskId: input.task.id,
        role: input.task.role,
        access: input.task.access,
        changedFiles: preview.files.map((file) => file.path),
      });
      return undefined;
    }
    if (decision.type === "RUN_COMMAND" && input.task.access === "PROPOSE_CHANGES") {
      const commandInput = commandInputFromDecision(decision);
      if (!isAllowedSubAgentVerificationCommand(commandInput) || isHighRiskCommandInput(commandInput)) {
        return failedResult(
          input.task,
          "PROTOCOL_VIOLATION",
          `Implementation child requested a command outside the isolated verification allowlist: ${renderCommandInput(commandInput)}`,
          input.usage,
          input.toolsCalled,
          input.evidence,
        );
      }
      const runner = new CommandRunner({
        repoPath: input.worktree.snapshot.repoPath,
        defaultTimeoutMs: 120_000,
        maxOutputChars: 20_000,
      });
      const display = renderCommandInput(commandInput);
      await input.onProgress?.({
        phase: "command_started",
        taskId: input.task.id,
        role: input.task.role,
        access: input.task.access,
        command: display,
      });
      const outputEvents: Array<Promise<void>> = [];
      const result = await runner.run(commandInput, {
        onOutput: (event) => {
          outputEvents.push(Promise.resolve(input.onProgress?.({
            phase: "command_output",
            taskId: input.task.id,
            role: input.task.role,
            access: input.task.access,
            stream: event.stream,
            message: event.chunk,
          })));
        },
      });
      await Promise.all(outputEvents);
      input.state.addCommandResult(result);
      input.state.setLastError(result.success ? null : result.stderr || result.error || `${display} failed`);
      input.toolsCalled.push("run_command");
      input.verification.push({
        command: result.command,
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      await input.onProgress?.({
        phase: "command_finished",
        taskId: input.task.id,
        role: input.task.role,
        access: input.task.access,
        command: result.command,
        success: result.success,
        exitCode: result.exitCode,
      });
      return undefined;
    }
    if (decision.type !== "TOOL_CALL") {
      return failedResult(
        input.task,
        "PROTOCOL_VIOLATION",
        `Child with ${input.task.access} access returned forbidden decision ${decision.type}.`,
        input.usage,
        input.toolsCalled,
        input.evidence,
      );
    }

    const spec = input.availableTools.find((tool) => tool.name === decision.toolName);
    if (!spec) {
      return failedResult(
        input.task,
        "PROTOCOL_VIOLATION",
        `Child requested unavailable or non-local read-only tool ${decision.toolName}.`,
        input.usage,
        input.toolsCalled,
        input.evidence,
      );
    }
    if (!input.ledger.tryConsumeToolCall()) {
      return failedResult(input.task, "BUDGET_EXHAUSTED", "Shared child tool-call budget exhausted.", input.usage, input.toolsCalled, input.evidence);
    }
    input.usage.toolCalls += 1;
    input.toolsCalled.push(decision.toolName);
    await input.onProgress?.({
      phase: "tool_started",
      taskId: input.task.id,
      role: input.task.role,
      access: input.task.access,
      toolName: decision.toolName,
    });
    const result = await input.registry.execute(decision.toolName, decision.input, {
      repoPath: input.worktree.snapshot.repoPath,
    });
    await input.onProgress?.({
      phase: "tool_finished",
      taskId: input.task.id,
      role: input.task.role,
      access: input.task.access,
      toolName: decision.toolName,
      success: result.success,
    });
    input.state.addToolResult({ toolName: decision.toolName, input: decision.input, result });
    input.evidence.push(...extractEvidenceRefs(decision.input, result.data));
    input.state.setLastError(result.success ? null : result.error?.message ?? `${decision.toolName} failed`);
    return undefined;
  }
}

class SubAgentBudgetLedger {
  private llmCalls = 0;
  private toolCalls = 0;

  constructor(private readonly policy: MultiAgentPolicy) {}

  tryConsumeLlmCall(): boolean {
    if (this.llmCalls >= this.policy.maxChildLlmCalls) return false;
    this.llmCalls += 1;
    return true;
  }

  tryConsumeToolCall(): boolean {
    if (this.toolCalls >= this.policy.maxChildToolCalls) return false;
    this.toolCalls += 1;
    return true;
  }
}

function selectSubAgentTools(tools: ToolSpec[]): ToolSpec[] {
  return selectToolsForOperatingMode(tools, "PLAN").filter((tool) => (
    tool.source === "local"
    && tool.annotations?.openWorldHint === false
  ));
}

function buildDelegatedGoal(
  originalGoal: string,
  task: SubAgentTask,
  dependencies: SubAgentResult[],
): string {
  const assignmentRule = task.access === "PROPOSE_CHANGES"
    ? "You have a disposable writable worktree. Use APPLY_PATCH one or more times to edit it, use safe RUN_COMMAND decisions to build or test when the repository supports verification, fix failures, then return FINAL. Read repository evidence before editing or deleting an existing file; a self-contained patch that only creates new files may be applied directly. The runtime derives the final proposal from the isolated worktree and never mutates the parent directly."
    : task.access === "REVIEW_CHANGES"
      ? "Review the dependency patch proposals against repository evidence. Return FINAL with concrete findings and a clear approve or request-changes recommendation. Never apply the patch."
      : "Inspect repository evidence with the available read-only tools and return FINAL with a concise evidence-backed report.";
  return [
    `You are the ${task.role} specialist in a coordinated coding task.`,
    `Original task: ${originalGoal}`,
    `Your assignment: ${task.objective}`,
    `Access protocol: ${task.access}`,
    `Focus paths: ${task.focusPaths.length > 0 ? task.focusPaths.join(", ") : "(discover as needed)"}`,
    assignmentRule,
    dependencies.length > 0
      ? `Dependency task ids: ${dependencies.map((result) => result.taskId).join(", ")}`
      : "Dependency task ids: (none)",
    task.access === "PROPOSE_CHANGES"
      ? "Never access the parent worktree, install dependencies, use the network, ask the user, or delegate again."
      : "Never modify files, run commands, ask the user, or delegate again.",
  ].join("\n");
}

function buildSubAgentContext(
  task: SubAgentTask,
  state: AgentState,
  dependencies: SubAgentResult[],
): string {
  const toolEvidence = state.toolResults.slice(-6).map((entry) => [
    `${entry.result.success ? "SUCCESS" : "FAILURE"} tool:${entry.toolName}`,
    `input: ${limitText(JSON.stringify(entry.input), 500)}`,
    entry.result.success
      ? `result: ${limitText(JSON.stringify(entry.result.data ?? null), 3_000)}`
      : `error: ${entry.result.error?.message ?? "unknown failure"}`,
  ].join("\n"));
  return [
    `Delegated task id: ${task.id}`,
    `Role: ${task.role}`,
    `Objective: ${task.objective}`,
    `Focus paths: ${task.focusPaths.length > 0 ? task.focusPaths.join(" | ") : "(none)"}`,
    `Access protocol: ${task.access}`,
    dependencies.length > 0
      ? `Dependency results:\n${formatDependencyResults(dependencies)}`
      : "Dependency results: (none)",
    `Latest error: ${state.lastError ?? "(none)"}`,
    `Read-only evidence:\n${toolEvidence.length > 0 ? toolEvidence.join("\n\n") : "(none yet)"}`,
  ].join("\n");
}

function formatDependencyResults(results: SubAgentResult[]): string {
  return results.map((result) => [
    `Task ${result.taskId}: ${result.summary}`,
    ...(result.proposedPatch ? [`Patch proposal:\n${result.proposedPatch}`] : []),
  ].join("\n")).join("\n\n");
}

function extractEvidenceRefs(input: Record<string, unknown>, data: unknown): SubAgentEvidenceRef[] {
  const refs: SubAgentEvidenceRef[] = [];
  if (typeof input.path === "string") refs.push({ path: input.path });
  if (!data || typeof data !== "object" || Array.isArray(data)) return refs;
  const record = data as Record<string, unknown>;
  if (typeof record.path === "string") {
    refs.push({
      path: record.path,
      ...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
      ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
    });
  }
  if (Array.isArray(record.results)) {
    for (const result of record.results) {
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const path = (result as Record<string, unknown>).path;
        if (typeof path === "string") refs.push({ path });
      }
    }
  }
  return refs;
}

function failedResult(
  task: SubAgentTask,
  status: Exclude<SubAgentResult["status"], "COMPLETED">,
  error: string,
  usage: SubAgentUsage,
  toolsCalled: string[],
  evidence: SubAgentEvidenceRef[],
): SubAgentResult {
  return {
    taskId: task.id,
    role: task.role,
    objective: task.objective,
    status,
    summary: error,
    evidence: uniqueEvidence(evidence),
    toolsCalled: [...toolsCalled],
    usage: { ...usage },
    error,
  };
}

function drainLlmCallMetrics(client: LlmClient): LlmCallMetrics[] {
  const drain = (client as { drainCallMetrics?: unknown }).drainCallMetrics;
  return typeof drain === "function"
    ? (drain as () => LlmCallMetrics[]).call(client)
    : [];
}

function addLlmMetrics(usage: SubAgentUsage, metrics: LlmCallMetrics[]): void {
  for (const metric of metrics) {
    usage.usageAvailable = usage.usageAvailable || metric.usage !== undefined;
    usage.promptTokens += metric.usage?.promptTokens ?? 0;
    usage.completionTokens += metric.usage?.completionTokens ?? 0;
    usage.totalTokens += metric.usage?.totalTokens ?? 0;
    usage.cachedPromptTokens += metric.usage?.cachedPromptTokens ?? 0;
    usage.reasoningTokens += metric.usage?.reasoningTokens ?? 0;
  }
}

function emptyUsage(): SubAgentUsage {
  return {
    steps: 0,
    llmCalls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    usageAvailable: false,
  };
}

function sumUsage(usages: SubAgentUsage[]): SubAgentUsage {
  return usages.reduce((total, usage) => ({
    steps: total.steps + usage.steps,
    llmCalls: total.llmCalls + usage.llmCalls,
    toolCalls: total.toolCalls + usage.toolCalls,
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
    cachedPromptTokens: total.cachedPromptTokens + usage.cachedPromptTokens,
    reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
    usageAvailable: total.usageAvailable || usage.usageAvailable,
  }), emptyUsage());
}

function uniqueEvidence(evidence: SubAgentEvidenceRef[]): SubAgentEvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((ref) => {
    const key = `${ref.path}:${String(ref.startLine ?? "")}:${String(ref.endLine ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 22))}\n...[truncated]...`;
}

function isRecoverableChildProtocolFailure(error: string): boolean {
  return /(?:invalid json|schema validation failed|did not contain a json object|did not include parsable content|response is empty|missing type)/i.test(error);
}

function summarizeChildDecision(decision: AgentDecision): string {
  switch (decision.type) {
    case "PLAN":
      return decision.message;
    case "TOOL_CALL":
      return `${decision.reason ?? "Inspect repository evidence"} → ${decision.toolName}`;
    case "DELEGATE":
    case "DELEGATE_READONLY":
      return decision.reason;
    case "APPLY_DELEGATED_PATCH":
    case "APPLY_PATCH":
    case "RUN_COMMAND":
      return decision.description;
    case "ASK_USER":
      return decision.message;
    case "FINAL":
      return decision.summary;
    case "FAILED":
      return decision.error;
  }
}

function commandInputFromDecision(
  decision: Extract<AgentDecision, { type: "RUN_COMMAND" }>,
): CommandInput {
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

function isAllowedSubAgentVerificationCommand(input: CommandInput): boolean {
  if (input.shell || !input.executable) return false;
  if ((input.args ?? []).some((arg) => path.isAbsolute(arg) || arg === ".." || arg.startsWith("../"))) {
    return false;
  }
  const executable = path.basename(input.executable).toLowerCase();
  const args = input.args ?? [];
  const firstCommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();

  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe"].includes(executable)) {
    if (firstCommand === "test") return true;
    if (firstCommand !== "run") return false;
    const runIndex = args.findIndex((arg) => arg.toLowerCase() === "run");
    const script = args[runIndex + 1]?.toLowerCase() ?? "";
    return /^(?:test(?::[\w.-]+)?|typecheck|lint(?::[\w.-]+)?|build|check|verify)$/.test(script);
  }
  if (["vitest", "vitest.cmd", "jest", "jest.cmd", "pytest", "pytest.exe", "tsc", "tsc.cmd", "eslint", "eslint.cmd"].includes(executable)) {
    return true;
  }
  if (["node", "node.exe"].includes(executable)) {
    return args[0] === "--check" && typeof args[1] === "string";
  }
  if (["cargo", "cargo.exe"].includes(executable)) {
    return firstCommand === "test" || firstCommand === "check" || firstCommand === "clippy";
  }
  if (["go", "go.exe"].includes(executable)) return firstCommand === "test";
  if (["python", "python.exe", "python3", "python3.exe"].includes(executable)) {
    const moduleIndex = args.findIndex((arg) => arg === "-m");
    return moduleIndex >= 0 && ["pytest", "unittest", "compileall"].includes(args[moduleIndex + 1]?.toLowerCase() ?? "");
  }
  if (["mvn", "mvn.cmd", "mvnw", "mvnw.cmd", "gradle", "gradle.bat", "gradlew", "gradlew.bat"].includes(executable)) {
    return args.some((arg) => /^(?:test|check|verify|build)$/.test(arg.toLowerCase()));
  }
  return executable === "make" && args.some((arg) => /^(?:test|check|verify|build)$/.test(arg.toLowerCase()));
}

function renderCommandInput(input: CommandInput): string {
  if (input.shell) return input.command ?? "";
  return [input.executable ?? "", ...(input.args ?? [])].filter(Boolean).join(" ");
}
