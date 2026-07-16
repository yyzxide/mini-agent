import { randomUUID } from "node:crypto";
import { AgentState } from "./AgentState.js";
import type { AgentDecision } from "./AgentDecision.js";
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
import type { LlmClient, ToolSpec } from "../llm/LlmClient.js";
import type { LlmCallMetrics } from "../llm/OpenAICompatibleClient.js";
import { createDefaultToolRegistry, type ToolRegistry } from "../tools/ToolRegistry.js";

export interface ReadonlySubAgentCoordinatorOptions {
  repoPath: string;
  createLlmClient: (identity: SubAgentIdentity) => Promise<LlmClient> | LlmClient;
  createToolRegistry?: () => ToolRegistry;
}

export class ReadonlySubAgentCoordinator implements SubAgentCoordinator {
  private readonly repoPath: string;
  private readonly createLlmClient: ReadonlySubAgentCoordinatorOptions["createLlmClient"];
  private readonly createToolRegistry: () => ToolRegistry;

  constructor(options: ReadonlySubAgentCoordinatorOptions) {
    this.repoPath = options.repoPath;
    this.createLlmClient = options.createLlmClient;
    this.createToolRegistry = options.createToolRegistry ?? createDefaultToolRegistry;
  }

  async runBatch(input: SubAgentBatchInput): Promise<SubAgentBatchResult> {
    if (input.tasks.length < 2 || input.tasks.length > Math.min(3, input.policy.maxTasksPerRun)) {
      throw new Error("Read-only delegation requires 2-3 tasks within the configured child-task budget.");
    }
    const startedAt = Date.now();
    const batchId = randomUUID();
    const ledger = new SubAgentBudgetLedger(input.policy);
    const results = new Array<SubAgentResult>(input.tasks.length);
    let nextTaskIndex = 0;
    let activeAgents = 0;
    let maxParallelAgents = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        const task = input.tasks[taskIndex];
        if (!task) return;
        activeAgents += 1;
        maxParallelAgents = Math.max(maxParallelAgents, activeAgents);
        try {
          results[taskIndex] = await this.runTask({
            parentRunId: input.parentRunId,
            batchId,
            originalGoal: input.originalGoal,
            task,
            policy: input.policy,
            ledger,
          });
        } finally {
          activeAgents -= 1;
        }
      }
    };

    const concurrency = Math.max(1, Math.min(input.policy.maxConcurrency, input.tasks.length));
    await Promise.all(Array.from({ length: concurrency }, worker));
    const stableResults = results.filter((result): result is SubAgentResult => result !== undefined);
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
  }): Promise<SubAgentResult> {
    const identity: SubAgentIdentity = {
      agentId: `${input.parentRunId}:${input.task.id}`,
      parentRunId: input.parentRunId,
      batchId: input.batchId,
      taskId: input.task.id,
      role: input.task.role,
    };
    const state = new AgentState({
      sessionId: identity.agentId,
      runId: identity.agentId,
      repoPath: this.repoPath,
      userGoal: buildDelegatedGoal(input.originalGoal, input.task),
      maxSteps: input.policy.maxChildSteps,
      operatingMode: "PLAN",
    });
    let registry: ToolRegistry | undefined;
    const toolsCalled: string[] = [];
    const evidence: SubAgentEvidenceRef[] = [];
    const usage = emptyUsage();

    try {
      registry = this.createToolRegistry();
      const availableTools = selectSubAgentTools(registry.listSpecs());
      const client = await this.createLlmClient(identity);
      while (!state.isStepLimitReached()) {
        if (!input.ledger.tryConsumeLlmCall()) {
          return failedResult(input.task, "BUDGET_EXHAUSTED", "Shared child LLM-call budget exhausted.", usage, toolsCalled, evidence);
        }
        usage.llmCalls += 1;
        const decision = await client.chat({
          userGoal: state.userGoal,
          context: buildSubAgentContext(input.task, state),
          state: state.toSnapshot(),
          availableTools,
        });
        addLlmMetrics(usage, drainLlmCallMetrics(client));
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
  }): Promise<SubAgentResult | undefined> {
    const { decision } = input;
    if (decision.type === "FINAL") {
      input.usage.steps = input.state.step;
      if (!decision.success) {
        return failedResult(input.task, "FAILED", decision.summary, input.usage, input.toolsCalled, input.evidence);
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
      };
    }
    if (decision.type === "FAILED") {
      return failedResult(input.task, "FAILED", decision.error, input.usage, input.toolsCalled, input.evidence);
    }
    if (decision.type === "PLAN") {
      input.state.addAssistantMessage(decision.message);
      return undefined;
    }
    if (decision.type !== "TOOL_CALL") {
      return failedResult(
        input.task,
        "PROTOCOL_VIOLATION",
        `Read-only child returned forbidden decision ${decision.type}.`,
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
    const result = await input.registry.execute(decision.toolName, decision.input, { repoPath: this.repoPath });
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

function buildDelegatedGoal(originalGoal: string, task: SubAgentTask): string {
  return [
    `You are the ${task.role} read-only specialist in a coordinated coding task.`,
    `Original task: ${originalGoal}`,
    `Your assignment: ${task.objective}`,
    `Focus paths: ${task.focusPaths.length > 0 ? task.focusPaths.join(", ") : "(discover as needed)"}`,
    "Inspect repository evidence with the available read-only tools. Never modify files, run commands, ask the user, or delegate again.",
    "Return FINAL with a concise evidence-backed report for the parent Agent.",
  ].join("\n");
}

function buildSubAgentContext(task: SubAgentTask, state: AgentState): string {
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
    `Latest error: ${state.lastError ?? "(none)"}`,
    `Read-only evidence:\n${toolEvidence.length > 0 ? toolEvidence.join("\n\n") : "(none yet)"}`,
  ].join("\n");
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
