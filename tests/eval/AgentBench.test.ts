import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBench, evaluateAgentBenchGate } from "../../src/eval/AgentBench.js";
import { loadAgentBenchDataset, loadAgentBenchReport } from "../../src/eval/AgentBenchDataset.js";
import type { AgentBenchSummary } from "../../src/eval/AgentBenchTypes.js";
import type { AgentBenchDataset } from "../../src/eval/AgentBenchTypes.js";
import type { LlmClient } from "../../src/llm/LlmClient.js";

describe("AgentBench", () => {
  it("loads and runs the versioned core dataset through its quality gate", async () => {
    const dataset = await loadAgentBenchDataset(path.resolve("benchmarks/agent-bench-v1.json"));
    const baseline = await loadAgentBenchReport(path.resolve("benchmarks/baselines/core-v1.json"));
    const report = await new AgentBench().run(dataset, { mode: "scripted", baseline });

    expect(report.summary).toMatchObject({
      scenarios: 7,
      totalRuns: 7,
      passedRuns: 7,
      passAt1: 1,
      passAtK: 1,
      toolChoiceAccuracy: 1,
    });
    expect(report.summary.contextTruncationRate).toBeGreaterThanOrEqual(0);
    expect(report.runs.some((run) => run.metrics.testsPassed > 0)).toBe(true);
    expect(report.runs.some((run) => run.metrics.verificationsPassed > 0)).toBe(true);
    expect(report.runs.every((run) => run.repoPath === undefined)).toBe(true);
    expect(report.gate).toEqual({ passed: true, failures: [], comparedToBaseline: true });
  });

  it("fails the gate on quality regression or excessive cost", () => {
    const baseline = reportWithSummary(summary({ passAt1: 1, runPassRate: 1, averageSteps: 2, averageLlmCalls: 2 }));
    const gate = evaluateAgentBenchGate(
      summary({ passAt1: 0.8, runPassRate: 0.75, averageSteps: 4, averageLlmCalls: 3 }),
      { minPassAt1: 0.9, maxAverageSteps: 3 },
      baseline,
      { maxPassAt1Regression: 0, maxRunPassRateRegression: 0, maxAverageStepsIncreaseRatio: 0.2 },
    );

    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("passAt1"),
      expect.stringContaining("runPassRate"),
      expect.stringContaining("averageSteps"),
    ]));
  });

  it("runs an injected real client and records provider token telemetry", async () => {
    const client: LlmClient & { drainCallMetrics: () => unknown[] } = {
      chat: async () => ({ type: "FINAL", success: true, summary: "done" }),
      completeText: async () => ({ success: true, text: "done" }),
      drainCallMetrics: () => [{
        model: "fixture-model",
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedPromptTokens: 3 },
      }],
    };
    const dataset: AgentBenchDataset = {
      version: 1,
      name: "real-fixture",
      scenarios: [{ id: "answer", name: "answer", userGoal: "answer", expected: { success: true } }],
    };

    const report = await new AgentBench().run(dataset, {
      mode: "real",
      model: "fixture-model",
      createLlmClient: () => client,
    });

    expect(report.mode).toBe("real");
    expect(report.summary).toMatchObject({ averageTotalTokens: 14, averageCachedPromptTokens: 3 });
    expect(report.runs[0]?.metrics).toMatchObject({ promptTokens: 10, completionTokens: 4, usageAvailable: true });
  });

  it("rejects a baseline from a different dataset", async () => {
    const dataset: AgentBenchDataset = {
      version: 1,
      name: "current",
      scenarios: [{ name: "done", userGoal: "done", decisions: [{ type: "FINAL", success: true, summary: "done" }] }],
    };
    await expect(new AgentBench().run(dataset, {
      mode: "scripted",
      baseline: reportWithSummary(summary()),
    })).rejects.toThrow("baseline dataset mismatch");
  });

  it("rejects an invalid or duplicate-id dataset", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-bench-invalid-"));
    const filePath = path.join(directory, "dataset.json");
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      name: "invalid",
      scenarios: [
        { id: "same", name: "one", userGoal: "one", decisions: [{ type: "FINAL", success: true, summary: "done" }] },
        { id: "same", name: "two", userGoal: "two", decisions: [{ type: "FINAL", success: true, summary: "done" }] },
      ],
    }), "utf8");

    await expect(loadAgentBenchDataset(filePath)).rejects.toThrow("duplicate scenario id same");
    await fs.rm(directory, { recursive: true, force: true });
  });
});

function summary(overrides: Partial<AgentBenchSummary> = {}): AgentBenchSummary {
  return {
    scenarios: 1,
    totalRuns: 1,
    passedRuns: 1,
    passAt1: 1,
    passAtK: 1,
    runPassRate: 1,
    toolChoiceAccuracy: 1,
    averageSteps: 1,
    averageLlmCalls: 1,
    averageDurationMs: 1,
    averageTotalTokens: 0,
    averageCachedPromptTokens: 0,
    contextTruncationRate: 0,
    failuresByCategory: {},
    ...overrides,
  };
}

function reportWithSummary(value: AgentBenchSummary) {
  return {
    version: 1 as const,
    dataset: "baseline",
    mode: "scripted" as const,
    startedAt: "2026-07-16T00:00:00.000Z",
    finishedAt: "2026-07-16T00:00:00.000Z",
    repetitions: 1,
    summary: value,
    scenarios: [],
    runs: [],
    gate: { passed: true, failures: [], comparedToBaseline: false },
  };
}
