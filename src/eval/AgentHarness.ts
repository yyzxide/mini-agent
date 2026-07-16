import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentDecision } from "../agent/AgentDecision.js";
import type { AgentOperatingMode } from "../agent/AgentOperatingMode.js";
import { AgentLoop } from "../agent/AgentLoop.js";
import type { AgentRunResult } from "../agent/AgentLoop.js";
import type { AgentProgressEvent } from "../agent/AgentLoop.js";
import { CommandRunner } from "../command/CommandRunner.js";
import { isVerificationCommand } from "../command/CommandClassification.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import type { LlmClient, LlmInput } from "../llm/LlmClient.js";
import type { LlmCallMetrics } from "../llm/OpenAICompatibleClient.js";
import { ScriptedLlmClient } from "./ScriptedLlmClient.js";
import type { MultiAgentPolicy, SubAgentCoordinator } from "../agent/SubAgentTypes.js";

const execFileAsync = promisify(execFile);

export interface AgentHarnessScenario {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  userGoal: string;
  files?: Record<string, string>;
  decisions?: AgentDecision[];
  maxSteps?: number;
  operatingMode?: AgentOperatingMode;
  expected?: {
    success?: boolean;
    diffContains?: string[];
    diffNotContains?: string[];
    filesContain?: Record<string, string>;
    filesNotContain?: Record<string, string>;
    toolsCalled?: string[];
    testsPassed?: boolean;
    verificationPassed?: boolean;
    maxSteps?: number;
    maxLlmCalls?: number;
    maxTotalTokens?: number;
  };
}

export interface AgentHarnessMetrics {
  steps: number;
  llmCalls: number;
  toolCalls: string[];
  patchCount: number;
  commandCount: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  usageAvailable: boolean;
  contextBuilds: number;
  contextSectionsSelected: number;
  contextSectionsTruncated: number;
  contextTruncationRate: number;
  testsPassed: number;
  testsFailed: number;
  verificationsPassed: number;
  verificationsFailed: number;
  failureCategory?: "MODEL" | "TOOL" | "PERMISSION" | "LOOP_GUARD" | "STEP_LIMIT" | "EXPECTATION" | "UNKNOWN";
}

export interface AgentHarnessResult {
  scenarioName: string;
  repoPath: string;
  run: AgentRunResult;
  llmCalls: number;
  passed: boolean;
  expectationFailures: string[];
  metrics: AgentHarnessMetrics;
}

export interface AgentHarnessSuiteResult {
  scenarios: AgentHarnessResult[];
  total: number;
  passed: number;
  successRate: number;
  averageSteps: number;
  toolChoiceAccuracy: number;
  averageLlmCalls: number;
  averageDurationMs: number;
  averageTotalTokens: number;
  contextTruncationRate: number;
  failuresByCategory: Record<string, number>;
}

export interface AgentHarnessRunOptions {
  llmClient?: LlmClient;
  subAgentCoordinator?: SubAgentCoordinator;
  multiAgent?: MultiAgentPolicy;
}

export class AgentHarness {
  async runScenario(scenario: AgentHarnessScenario, options: AgentHarnessRunOptions = {}): Promise<AgentHarnessResult> {
    const repoPath = await createScenarioRepo(scenario);
    if (!options.llmClient && (!scenario.decisions || scenario.decisions.length === 0)) {
      throw new Error(`Scenario ${scenario.name} requires scripted decisions or an injected LLM client`);
    }
    const llmClient = new InstrumentedLlmClient(options.llmClient ?? new ScriptedLlmClient(scenario.decisions ?? []));
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const progress: AgentProgressEvent[] = [];
    const loop = new AgentLoop({
      repoPath,
      llmClient,
      toolRegistry: createDefaultToolRegistry(),
      sessionStore,
      eventStore,
      commandRunner: new CommandRunner({ repoPath }),
      permissionManager: new PermissionManager({ prompt: async () => "yes" }),
      patchManager: new PatchManager({ repoPath }),
      contextBuilder: new ContextBuilder({ repoPath }),
      onProgress: (event) => { progress.push(event); },
      ...(options.subAgentCoordinator ? { subAgentCoordinator: options.subAgentCoordinator } : {}),
    });

    const startedAt = Date.now();
    const run = await loop.run({
      userGoal: scenario.userGoal,
      autoApprove: true,
      nonInteractive: true,
      operatingMode: scenario.operatingMode ?? "EXECUTE",
      ...(scenario.maxSteps === undefined ? {} : { maxSteps: scenario.maxSteps }),
      ...(options.multiAgent ? { multiAgent: options.multiAgent } : {}),
    });
    const durationMs = Date.now() - startedAt;

    const records = await sessionStore.readRecords(run.sessionId);
    const events = await eventStore.readEvents(run.sessionId);
    const telemetry = collectHarnessTelemetry(records, events);
    const llmCalls = llmClient.calls + countRecordedSubAgentLlmCalls(records);
    const toolCalls = [
      ...progress.filter((event): event is Extract<AgentProgressEvent, { type: "tool" }> => event.type === "tool")
        .map((event) => event.toolName),
      ...collectRecordedSubAgentTools(records),
    ];

    const expectationFailures = await evaluateScenarioExpectation(repoPath, run, scenario.expected, {
      llmCalls,
      toolCalls,
      metrics: { durationMs, ...telemetry },
    });
    const metrics: AgentHarnessMetrics = {
      steps: run.steps,
      llmCalls,
      toolCalls,
      patchCount: progress.filter((event) => event.type === "patch").length,
      commandCount: progress.filter((event) => event.type === "command").length,
      durationMs,
      ...telemetry,
      ...(!run.success || expectationFailures.length > 0
        ? { failureCategory: classifyFailure(run.error, expectationFailures) }
        : {}),
    };

    return {
      scenarioName: scenario.name,
      repoPath,
      run,
      llmCalls,
      passed: expectationFailures.length === 0,
      expectationFailures,
      metrics,
    };
  }

  async runSuite(scenarios: AgentHarnessScenario[]): Promise<AgentHarnessSuiteResult> {
    const results = await Promise.all(scenarios.map(async (scenario) => await this.runScenario(scenario)));
    const passed = results.filter((result) => result.passed).length;
    const expectedToolScenarios = results.filter((_, index) => (scenarios[index]?.expected?.toolsCalled?.length ?? 0) > 0);
    const correctToolScenarios = expectedToolScenarios.filter((result) => {
      const scenario = scenarios[results.indexOf(result)];
      return scenario?.expected?.toolsCalled?.every((tool) => result.metrics.toolCalls.includes(tool)) ?? false;
    });
    const failuresByCategory: Record<string, number> = {};
    for (const result of results) {
      if (result.metrics.failureCategory) {
        failuresByCategory[result.metrics.failureCategory] = (failuresByCategory[result.metrics.failureCategory] ?? 0) + 1;
      }
    }
    return {
      scenarios: results,
      total: results.length,
      passed,
      successRate: results.length === 0 ? 1 : passed / results.length,
      averageSteps: results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.metrics.steps, 0) / results.length,
      toolChoiceAccuracy: expectedToolScenarios.length === 0 ? 1 : correctToolScenarios.length / expectedToolScenarios.length,
      averageLlmCalls: average(results.map((result) => result.metrics.llmCalls)),
      averageDurationMs: average(results.map((result) => result.metrics.durationMs)),
      averageTotalTokens: average(results.map((result) => result.metrics.totalTokens)),
      contextTruncationRate: ratio(
        results.reduce((sum, result) => sum + result.metrics.contextSectionsTruncated, 0),
        results.reduce((sum, result) => sum + result.metrics.contextSectionsSelected, 0),
      ),
      failuresByCategory,
    };
  }
}

function countRecordedSubAgentLlmCalls(records: Awaited<ReturnType<SessionStore["readRecords"]>>): number {
  return records.reduce((total, record) => {
    if (record.type !== "LLM_USAGE" || typeof record.payload.mode !== "string"
      || !record.payload.mode.startsWith("subagent:")) return total;
    return total + (typeof record.payload.llmCalls === "number" ? record.payload.llmCalls : 1);
  }, 0);
}

function collectRecordedSubAgentTools(records: Awaited<ReturnType<SessionStore["readRecords"]>>): string[] {
  const tools: string[] = [];
  for (const record of records) {
    if (record.type !== "SUBAGENT_BATCH_RESULT" || !Array.isArray(record.payload.results)) continue;
    for (const result of record.payload.results) {
      if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.toolsCalled)) continue;
      tools.push(...result.toolsCalled.filter((tool): tool is string => typeof tool === "string"));
    }
  }
  return tools;
}

async function createScenarioRepo(scenario: AgentHarnessScenario): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-harness-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });

  for (const [relativePath, content] of Object.entries(scenario.files ?? {})) {
    const filePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  if (Object.keys(scenario.files ?? {}).length > 0) {
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
  }

  return repoPath;
}

async function evaluateScenarioExpectation(
  repoPath: string,
  run: AgentRunResult,
  expected: AgentHarnessScenario["expected"],
  observed: {
    llmCalls: number;
    toolCalls: string[];
    metrics: Pick<
      AgentHarnessMetrics,
      "durationMs" | "totalTokens" | "testsPassed" | "testsFailed" | "verificationsPassed" | "verificationsFailed"
    >;
  },
): Promise<string[]> {
  if (!expected) {
    return [];
  }

  const failures: string[] = [];

  if (expected.success !== undefined && run.success !== expected.success) {
    failures.push(`Expected success=${String(expected.success)} but got ${String(run.success)}`);
  }

  for (const text of expected.diffContains ?? []) {
    if (!run.finalDiff.includes(text)) {
      failures.push(`Expected final diff to contain ${JSON.stringify(text)}`);
    }
  }
  for (const text of expected.diffNotContains ?? []) {
    if (run.finalDiff.includes(text)) {
      failures.push(`Expected final diff not to contain ${JSON.stringify(text)}`);
    }
  }

  for (const [relativePath, text] of Object.entries(expected.filesContain ?? {})) {
    const content = await fs.readFile(path.join(repoPath, relativePath), "utf8").catch(() => undefined);
    if (content === undefined) {
      failures.push(`Expected file to exist: ${relativePath}`);
    } else if (!content.includes(text)) {
      failures.push(`Expected ${relativePath} to contain ${JSON.stringify(text)}`);
    }
  }
  for (const [relativePath, text] of Object.entries(expected.filesNotContain ?? {})) {
    const content = await fs.readFile(path.join(repoPath, relativePath), "utf8").catch(() => undefined);
    if (content?.includes(text)) {
      failures.push(`Expected ${relativePath} not to contain ${JSON.stringify(text)}`);
    }
  }

  for (const tool of expected.toolsCalled ?? []) {
    if (!observed.toolCalls.includes(tool)) failures.push(`Expected tool to be called: ${tool}`);
  }
  if (expected.maxSteps !== undefined && run.steps > expected.maxSteps) {
    failures.push(`Expected at most ${expected.maxSteps} steps but got ${run.steps}`);
  }
  if (expected.maxLlmCalls !== undefined && observed.llmCalls > expected.maxLlmCalls) {
    failures.push(`Expected at most ${expected.maxLlmCalls} LLM calls but got ${observed.llmCalls}`);
  }
  if (expected.maxTotalTokens !== undefined && observed.metrics.totalTokens > expected.maxTotalTokens) {
    failures.push(`Expected at most ${expected.maxTotalTokens} total tokens but got ${observed.metrics.totalTokens}`);
  }
  if (expected.testsPassed === true && observed.metrics.testsPassed === 0) {
    failures.push("Expected at least one successful test command");
  }
  if (expected.testsPassed === false && observed.metrics.testsFailed === 0) {
    failures.push("Expected at least one failed test command");
  }
  if (expected.verificationPassed === true && observed.metrics.verificationsPassed === 0) {
    failures.push("Expected at least one successful verification command");
  }
  if (expected.verificationPassed === false && observed.metrics.verificationsFailed === 0) {
    failures.push("Expected at least one failed verification command");
  }

  return failures;
}

class InstrumentedLlmClient implements LlmClient {
  calls = 0;

  constructor(private readonly delegate: LlmClient) {}

  async chat(input: LlmInput): Promise<AgentDecision> {
    this.calls += 1;
    return await this.delegate.chat(input);
  }

  drainCallMetrics(): LlmCallMetrics[] {
    const drain = (this.delegate as { drainCallMetrics?: unknown }).drainCallMetrics;
    return typeof drain === "function"
      ? (drain as () => LlmCallMetrics[]).call(this.delegate)
      : [];
  }
}

function collectHarnessTelemetry(
  records: Awaited<ReturnType<SessionStore["readRecords"]>>,
  events: Awaited<ReturnType<EventStore["readEvents"]>>,
): Omit<AgentHarnessMetrics, "steps" | "llmCalls" | "toolCalls" | "patchCount" | "commandCount" | "durationMs" | "failureCategory"> {
  const usage = records.filter((record) => record.type === "LLM_USAGE");
  const contextEvents = events.filter((event) => event.type === "CONTEXT_BUILT");
  let contextSectionsSelected = 0;
  let contextSectionsTruncated = 0;
  for (const event of contextEvents) {
    const trace = event.payload.trace;
    if (!trace || typeof trace !== "object" || Array.isArray(trace)) continue;
    const sections = "sections" in trace ? trace.sections : undefined;
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      if (!section || typeof section !== "object" || Array.isArray(section)) continue;
      if ("selected" in section && section.selected === true) contextSectionsSelected += 1;
      if ("selected" in section && section.selected === true && "truncated" in section && section.truncated === true) {
        contextSectionsTruncated += 1;
      }
    }
  }
  const testsPassed = events.filter((event) => event.type === "TEST_PASSED").length;
  const testsFailed = events.filter((event) => event.type === "TEST_FAILED").length;
  const verificationResults = records.filter((record) => (
    record.type === "COMMAND_RESULT"
    && typeof record.payload.command === "string"
    && isVerificationCommand(record.payload.command)
  ));
  return {
    promptTokens: sumPayloadNumber(usage, "promptTokens"),
    completionTokens: sumPayloadNumber(usage, "completionTokens"),
    totalTokens: sumPayloadNumber(usage, "totalTokens"),
    cachedPromptTokens: sumPayloadNumber(usage, "cachedPromptTokens"),
    reasoningTokens: sumPayloadNumber(usage, "reasoningTokens"),
    usageAvailable: usage.some((record) => record.payload.usageAvailable === true),
    contextBuilds: contextEvents.length,
    contextSectionsSelected,
    contextSectionsTruncated,
    contextTruncationRate: ratio(contextSectionsTruncated, contextSectionsSelected),
    testsPassed,
    testsFailed,
    verificationsPassed: verificationResults.filter((record) => record.payload.success === true).length,
    verificationsFailed: verificationResults.filter((record) => record.payload.success !== true).length,
  };
}

function sumPayloadNumber(records: Awaited<ReturnType<SessionStore["readRecords"]>>, key: string): number {
  return records.reduce((sum, record) => {
    const value = record.payload[key];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function classifyFailure(
  error: string | undefined,
  expectationFailures: string[],
): NonNullable<AgentHarnessMetrics["failureCategory"]> {
  if (expectationFailures.length > 0) return "EXPECTATION";
  const normalized = error?.toLowerCase() ?? "";
  if (normalized.includes("permission") || normalized.includes("denied")) return "PERMISSION";
  if (normalized.includes("repeated") || normalized.includes("consecutive")) return "LOOP_GUARD";
  if (normalized.includes("max steps") || normalized.includes("reaching max")) return "STEP_LIMIT";
  if (normalized.includes("tool")) return "TOOL";
  if (normalized.includes("model") || normalized.includes("llm")) return "MODEL";
  return "UNKNOWN";
}
