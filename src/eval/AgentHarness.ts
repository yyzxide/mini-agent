import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentDecision } from "../agent/AgentDecision.js";
import { AgentLoop } from "../agent/AgentLoop.js";
import type { AgentRunResult } from "../agent/AgentLoop.js";
import type { AgentProgressEvent } from "../agent/AgentLoop.js";
import { CommandRunner } from "../command/CommandRunner.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import { ScriptedLlmClient } from "./ScriptedLlmClient.js";

const execFileAsync = promisify(execFile);

export interface AgentHarnessScenario {
  name: string;
  userGoal: string;
  files?: Record<string, string>;
  decisions: AgentDecision[];
  maxSteps?: number;
  expected?: {
    success?: boolean;
    diffContains?: string[];
    filesContain?: Record<string, string>;
    toolsCalled?: string[];
    maxSteps?: number;
    maxLlmCalls?: number;
  };
}

export interface AgentHarnessMetrics {
  steps: number;
  llmCalls: number;
  toolCalls: string[];
  patchCount: number;
  commandCount: number;
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
  failuresByCategory: Record<string, number>;
}

export class AgentHarness {
  async runScenario(scenario: AgentHarnessScenario): Promise<AgentHarnessResult> {
    const repoPath = await createScenarioRepo(scenario);
    const llmClient = new ScriptedLlmClient(scenario.decisions);
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
    });

    const run = await loop.run({
      userGoal: scenario.userGoal,
      autoApprove: true,
      nonInteractive: true,
      ...(scenario.maxSteps === undefined ? {} : { maxSteps: scenario.maxSteps }),
    });

    const expectationFailures = await evaluateScenarioExpectation(repoPath, run, scenario.expected, {
      llmCalls: llmClient.getCallInputs().length,
      progress,
    });
    const toolCalls = progress.filter((event): event is Extract<AgentProgressEvent, { type: "tool" }> => event.type === "tool")
      .map((event) => event.toolName);
    const metrics: AgentHarnessMetrics = {
      steps: run.steps,
      llmCalls: llmClient.getCallInputs().length,
      toolCalls,
      patchCount: progress.filter((event) => event.type === "patch").length,
      commandCount: progress.filter((event) => event.type === "command").length,
      ...(!run.success || expectationFailures.length > 0
        ? { failureCategory: classifyFailure(run.error, expectationFailures) }
        : {}),
    };

    return {
      scenarioName: scenario.name,
      repoPath,
      run,
      llmCalls: llmClient.getCallInputs().length,
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
      failuresByCategory,
    };
  }
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
  observed: { llmCalls: number; progress: AgentProgressEvent[] },
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

  for (const [relativePath, text] of Object.entries(expected.filesContain ?? {})) {
    const content = await fs.readFile(path.join(repoPath, relativePath), "utf8").catch(() => undefined);
    if (content === undefined) {
      failures.push(`Expected file to exist: ${relativePath}`);
    } else if (!content.includes(text)) {
      failures.push(`Expected ${relativePath} to contain ${JSON.stringify(text)}`);
    }
  }

  const toolCalls = observed.progress
    .filter((event): event is Extract<AgentProgressEvent, { type: "tool" }> => event.type === "tool")
    .map((event) => event.toolName);
  for (const tool of expected.toolsCalled ?? []) {
    if (!toolCalls.includes(tool)) failures.push(`Expected tool to be called: ${tool}`);
  }
  if (expected.maxSteps !== undefined && run.steps > expected.maxSteps) {
    failures.push(`Expected at most ${expected.maxSteps} steps but got ${run.steps}`);
  }
  if (expected.maxLlmCalls !== undefined && observed.llmCalls > expected.maxLlmCalls) {
    failures.push(`Expected at most ${expected.maxLlmCalls} LLM calls but got ${observed.llmCalls}`);
  }

  return failures;
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
