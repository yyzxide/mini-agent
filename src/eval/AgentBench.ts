import fs from "node:fs/promises";
import type { LlmClient } from "../llm/LlmClient.js";
import { AgentHarness, type AgentHarnessResult, type AgentHarnessScenario } from "./AgentHarness.js";
import type {
  AgentBenchBaselinePolicy,
  AgentBenchComparison,
  AgentBenchDataset,
  AgentBenchGateResult,
  AgentBenchMode,
  AgentBenchReport,
  AgentBenchRunResult,
  AgentBenchScenarioSummary,
  AgentBenchSummary,
  AgentBenchThresholds,
} from "./AgentBenchTypes.js";

export interface AgentBenchOptions {
  mode: AgentBenchMode;
  repetitions?: number;
  model?: string;
  baseline?: AgentBenchReport;
  keepRepos?: boolean;
  createLlmClient?: (scenario: AgentHarnessScenario, repetition: number) => Promise<LlmClient> | LlmClient;
}

export class AgentBench {
  constructor(private readonly harness = new AgentHarness()) {}

  async run(dataset: AgentBenchDataset, options: AgentBenchOptions): Promise<AgentBenchReport> {
    const repetitions = options.repetitions ?? dataset.repetitions ?? 1;
    if (!Number.isInteger(repetitions) || repetitions <= 0 || repetitions > 20) {
      throw new Error("AgentBench repetitions must be an integer from 1 to 20");
    }
    if (options.mode === "real" && !options.createLlmClient) {
      throw new Error("Real AgentBench mode requires an LLM client factory");
    }
    if (options.baseline && options.baseline.dataset !== dataset.name) {
      throw new Error(`AgentBench baseline dataset mismatch: expected ${dataset.name}, received ${options.baseline.dataset}`);
    }
    if (options.baseline && options.baseline.mode !== options.mode) {
      throw new Error(`AgentBench baseline mode mismatch: expected ${options.mode}, received ${options.baseline.mode}`);
    }
    const startedAt = new Date().toISOString();
    const runs: AgentBenchRunResult[] = [];

    for (const scenario of dataset.scenarios) {
      if (options.mode === "scripted" && (!scenario.decisions || scenario.decisions.length === 0)) {
        throw new Error(`Scripted AgentBench scenario ${scenario.id ?? scenario.name} has no decisions`);
      }
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const llmClient = options.mode === "real"
          ? await options.createLlmClient?.(scenario, repetition)
          : undefined;
        let result: AgentHarnessResult | undefined;
        try {
          result = await this.harness.runScenario(scenario, llmClient ? { llmClient } : {});
          runs.push(toBenchRun(result, scenario, repetition, options.keepRepos === true));
        } finally {
          if (result && options.keepRepos !== true) {
            await fs.rm(result.repoPath, { recursive: true, force: true });
          }
        }
      }
    }

    const scenarios = summarizeScenarios(dataset.scenarios, runs);
    const summary = summarizeRuns(dataset.scenarios, scenarios, runs);
    const gate = evaluateAgentBenchGate(summary, dataset.thresholds, options.baseline, dataset.baselinePolicy);
    const report: AgentBenchReport = {
      version: 1,
      dataset: dataset.name,
      mode: options.mode,
      ...(options.model ? { model: options.model } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      repetitions,
      summary,
      scenarios,
      runs,
      gate,
    };
    if (options.baseline) report.comparison = compareAgentBenchReports(report, options.baseline);
    return report;
  }
}

export function evaluateAgentBenchGate(
  summary: AgentBenchSummary,
  thresholds: AgentBenchThresholds = {},
  baseline?: AgentBenchReport,
  baselinePolicy: AgentBenchBaselinePolicy = {},
): AgentBenchGateResult {
  const failures: string[] = [];
  requireMinimum(failures, "passAt1", summary.passAt1, thresholds.minPassAt1);
  requireMinimum(failures, "passAtK", summary.passAtK, thresholds.minPassAtK);
  requireMinimum(failures, "runPassRate", summary.runPassRate, thresholds.minRunPassRate);
  requireMinimum(failures, "toolChoiceAccuracy", summary.toolChoiceAccuracy, thresholds.minToolChoiceAccuracy);
  requireMinimum(failures, "allRunsPassRate", summary.allRunsPassRate, thresholds.minAllRunsPassRate);
  requireMaximum(failures, "flakyScenarios", summary.flakyScenarios, thresholds.maxFlakyScenarios);
  requireMaximum(failures, "averageSteps", summary.averageSteps, thresholds.maxAverageSteps);
  requireMaximum(failures, "averageLlmCalls", summary.averageLlmCalls, thresholds.maxAverageLlmCalls);
  requireMaximum(failures, "averageTotalTokens", summary.averageTotalTokens, thresholds.maxAverageTotalTokens);
  requireMaximum(failures, "averageDurationMs", summary.averageDurationMs, thresholds.maxAverageDurationMs);
  requireMaximum(failures, "contextTruncationRate", summary.contextTruncationRate, thresholds.maxContextTruncationRate);

  if (baseline) {
    requireRegression(failures, "passAt1", baseline.summary.passAt1 - summary.passAt1, baselinePolicy.maxPassAt1Regression ?? 0);
    requireRegression(failures, "runPassRate", baseline.summary.runPassRate - summary.runPassRate, baselinePolicy.maxRunPassRateRegression ?? 0);
    requireRegression(failures, "allRunsPassRate", readAllRunsPassRate(baseline) - summary.allRunsPassRate, baselinePolicy.maxAllRunsPassRateRegression ?? 0);
    requireRegression(failures, "toolChoiceAccuracy", baseline.summary.toolChoiceAccuracy - summary.toolChoiceAccuracy, baselinePolicy.maxToolChoiceAccuracyRegression ?? 0);
    requireIncreaseRatio(failures, "averageSteps", summary.averageSteps, baseline.summary.averageSteps, baselinePolicy.maxAverageStepsIncreaseRatio ?? 0.1);
    requireIncreaseRatio(failures, "averageLlmCalls", summary.averageLlmCalls, baseline.summary.averageLlmCalls, baselinePolicy.maxAverageLlmCallsIncreaseRatio ?? 0.1);
    if (baseline.summary.averageTotalTokens > 0) {
      requireIncreaseRatio(failures, "averageTotalTokens", summary.averageTotalTokens, baseline.summary.averageTotalTokens, baselinePolicy.maxAverageTotalTokensIncreaseRatio ?? 0.2);
    }
  }

  return { passed: failures.length === 0, failures, comparedToBaseline: baseline !== undefined };
}

function toBenchRun(
  result: AgentHarnessResult,
  scenario: AgentHarnessScenario,
  repetition: number,
  keepRepo: boolean,
): AgentBenchRunResult {
  return {
    scenarioId: scenario.id ?? scenario.name,
    scenarioName: scenario.name,
    repetition,
    passed: result.passed,
    success: result.run.success,
    summary: result.run.summary,
    ...(result.run.error ? { error: result.run.error } : {}),
    ...(result.run.failureCode ? { failureCode: result.run.failureCode } : {}),
    expectationFailures: result.expectationFailures,
    metrics: result.metrics,
    ...(keepRepo ? { repoPath: result.repoPath } : {}),
  };
}

function summarizeScenarios(scenarios: AgentHarnessScenario[], runs: AgentBenchRunResult[]): AgentBenchScenarioSummary[] {
  return scenarios.map((scenario) => {
    const scenarioId = scenario.id ?? scenario.name;
    const matching = runs.filter((run) => run.scenarioId === scenarioId);
    const passed = matching.filter((run) => run.passed).length;
    const failuresByCategory: Record<string, number> = {};
    for (const run of matching) {
      const category = run.metrics.failureCategory;
      if (category) failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
    }
    return {
      scenarioId,
      scenarioName: scenario.name,
      runs: matching.length,
      passed,
      passRate: ratio(passed, matching.length),
      passedAtLeastOnce: passed > 0,
      firstRunPassed: matching[0]?.passed ?? false,
      allRunsPassed: matching.length > 0 && passed === matching.length,
      flaky: passed > 0 && passed < matching.length,
      averageSteps: average(matching.map((run) => run.metrics.steps)),
      averageTotalTokens: average(matching.map((run) => run.metrics.totalTokens)),
      failuresByCategory,
    };
  });
}

function summarizeRuns(
  scenarios: AgentHarnessScenario[],
  scenarioSummaries: AgentBenchScenarioSummary[],
  runs: AgentBenchRunResult[],
): AgentBenchSummary {
  const expectedTools = new Map(scenarios.map((scenario) => [scenario.id ?? scenario.name, scenario.expected?.toolsCalled ?? []]));
  const toolRuns = runs.filter((run) => (expectedTools.get(run.scenarioId)?.length ?? 0) > 0);
  const correctToolRuns = toolRuns.filter((run) => (
    expectedTools.get(run.scenarioId)?.every((tool) => run.metrics.toolCalls.includes(tool)) ?? false
  ));
  const failuresByCategory: Record<string, number> = {};
  for (const run of runs) {
    const category = run.metrics.failureCategory;
    if (category) failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
  }
  const selected = sum(runs.map((run) => run.metrics.contextSectionsSelected));
  const passedRuns = runs.filter((run) => run.passed).length;
  return {
    scenarios: scenarioSummaries.length,
    totalRuns: runs.length,
    passedRuns,
    passAt1: ratio(scenarioSummaries.filter((scenario) => scenario.firstRunPassed).length, scenarioSummaries.length),
    passAtK: ratio(scenarioSummaries.filter((scenario) => scenario.passedAtLeastOnce).length, scenarioSummaries.length),
    runPassRate: ratio(passedRuns, runs.length),
    toolChoiceAccuracy: toolRuns.length === 0 ? 1 : ratio(correctToolRuns.length, toolRuns.length),
    allRunsPassRate: ratio(scenarioSummaries.filter((scenario) => scenario.allRunsPassed).length, scenarioSummaries.length),
    flakyScenarios: scenarioSummaries.filter((scenario) => scenario.flaky).length,
    runPassRate95CI: wilsonInterval(passedRuns, runs.length),
    averageSteps: average(runs.map((run) => run.metrics.steps)),
    averageLlmCalls: average(runs.map((run) => run.metrics.llmCalls)),
    averageDurationMs: average(runs.map((run) => run.metrics.durationMs)),
    averageTotalTokens: average(runs.map((run) => run.metrics.totalTokens)),
    averageCachedPromptTokens: average(runs.map((run) => run.metrics.cachedPromptTokens)),
    contextTruncationRate: ratio(sum(runs.map((run) => run.metrics.contextSectionsTruncated)), selected),
    failuresByCategory,
  };
}

export function compareAgentBenchReports(
  current: AgentBenchReport,
  baseline: AgentBenchReport,
): AgentBenchComparison {
  if (current.dataset !== baseline.dataset) {
    throw new Error(`AgentBench comparison dataset mismatch: expected ${current.dataset}, received ${baseline.dataset}`);
  }
  if (current.mode !== baseline.mode) {
    throw new Error(`AgentBench comparison mode mismatch: expected ${current.mode}, received ${baseline.mode}`);
  }
  const baselineScenarios = new Map(baseline.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  return {
    dataset: current.dataset,
    mode: current.mode,
    currentStartedAt: current.startedAt,
    baselineStartedAt: baseline.startedAt,
    metricDeltas: {
      passAt1: current.summary.passAt1 - baseline.summary.passAt1,
      passAtK: current.summary.passAtK - baseline.summary.passAtK,
      runPassRate: current.summary.runPassRate - baseline.summary.runPassRate,
      allRunsPassRate: readAllRunsPassRate(current) - readAllRunsPassRate(baseline),
      toolChoiceAccuracy: current.summary.toolChoiceAccuracy - baseline.summary.toolChoiceAccuracy,
      averageSteps: current.summary.averageSteps - baseline.summary.averageSteps,
      averageLlmCalls: current.summary.averageLlmCalls - baseline.summary.averageLlmCalls,
      averageDurationMs: current.summary.averageDurationMs - baseline.summary.averageDurationMs,
      averageTotalTokens: current.summary.averageTotalTokens - baseline.summary.averageTotalTokens,
      contextTruncationRate: current.summary.contextTruncationRate - baseline.summary.contextTruncationRate,
      flakyScenarios: readFlakyScenarios(current) - readFlakyScenarios(baseline),
    },
    scenarios: current.scenarios
      .filter((scenario) => baselineScenarios.has(scenario.scenarioId))
      .map((scenario) => {
        const baselineScenario = baselineScenarios.get(scenario.scenarioId);
        const baselinePassRate = baselineScenario?.passRate ?? 0;
        return {
          scenarioId: scenario.scenarioId,
          currentPassRate: scenario.passRate,
          baselinePassRate,
          delta: scenario.passRate - baselinePassRate,
        };
      }),
  };
}

export function renderAgentBenchMarkdownReport(report: AgentBenchReport): string {
  const summary = report.summary;
  const lines = [
    "# Mini Agent 真实模型验收报告",
    "",
    `- 数据集：\`${report.dataset}\``,
    `- 模式：\`${report.mode}\``,
    `- 模型：\`${report.model ?? "未记录"}\``,
    `- 重复次数：${String(report.repetitions)}`,
    `- 时间：${report.startedAt} ～ ${report.finishedAt}`,
    `- 门禁：${report.gate.passed ? "通过" : "未通过"}`,
    "",
    "## 总体指标",
    "",
    "| 指标 | 结果 |",
    "| --- | ---: |",
    `| Pass@1 | ${formatPercent(summary.passAt1)} |`,
    `| Pass@K | ${formatPercent(summary.passAtK)} |`,
    `| Run pass rate | ${formatPercent(summary.runPassRate)} |`,
    `| All-runs pass rate | ${formatPercent(summary.allRunsPassRate)} |`,
    `| Tool choice accuracy | ${formatPercent(summary.toolChoiceAccuracy)} |`,
    `| Flaky scenarios | ${String(summary.flakyScenarios)} |`,
    `| 平均步骤 | ${summary.averageSteps.toFixed(2)} |`,
    `| 平均 LLM 调用 | ${summary.averageLlmCalls.toFixed(2)} |`,
    `| 平均 Token | ${summary.averageTotalTokens.toFixed(0)} |`,
    `| 平均耗时 | ${summary.averageDurationMs.toFixed(0)} ms |`,
    `| Context 截断率 | ${formatPercent(summary.contextTruncationRate)} |`,
    "",
    "## 场景结果",
    "",
    "| 场景 | 通过率 | 首轮 | 全轮 | Flaky |",
    "| --- | ---: | --- | --- | --- |",
    ...report.scenarios.map((scenario) =>
      `| ${escapeMarkdownTable(scenario.scenarioName)} | ${formatPercent(scenario.passRate)} | ${scenario.firstRunPassed ? "通过" : "失败"} | ${scenario.allRunsPassed ? "通过" : "失败"} | ${scenario.flaky ? "是" : "否"} |`,
    ),
  ];
  const failedRuns = report.runs.filter((run) => !run.passed);
  if (failedRuns.length > 0 || report.gate.failures.length > 0) {
    lines.push("", "## 失败与门禁", "");
    for (const failure of report.gate.failures) lines.push(`- 门禁：${failure}`);
    for (const run of failedRuns) {
      const details = run.expectationFailures.length > 0
        ? run.expectationFailures.join("；")
        : run.error ?? run.failureCode ?? "未知失败";
      lines.push(`- ${run.scenarioName} #${String(run.repetition)}：${details}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function readAllRunsPassRate(report: AgentBenchReport): number {
  return report.summary.allRunsPassRate ?? ratio(
    report.scenarios.filter((scenario) => scenario.allRunsPassed ?? scenario.passRate === 1).length,
    report.scenarios.length,
  );
}

function readFlakyScenarios(report: AgentBenchReport): number {
  return report.summary.flakyScenarios ?? report.scenarios.filter((scenario) =>
    scenario.flaky ?? (scenario.passRate > 0 && scenario.passRate < 1),
  ).length;
}

function wilsonInterval(successes: number, total: number): { confidence: 0.95; lower: number; upper: number } {
  if (total <= 0) return { confidence: 0.95, lower: 0, upper: 1 };
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total) / denominator;
  return {
    confidence: 0.95,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function requireMinimum(failures: string[], metric: string, actual: number, minimum: number | undefined): void {
  if (minimum !== undefined && actual < minimum) failures.push(`${metric} ${actual.toFixed(4)} is below minimum ${minimum.toFixed(4)}`);
}

function requireMaximum(failures: string[], metric: string, actual: number, maximum: number | undefined): void {
  if (maximum !== undefined && actual > maximum) failures.push(`${metric} ${actual.toFixed(4)} exceeds maximum ${maximum.toFixed(4)}`);
}

function requireRegression(failures: string[], metric: string, regression: number, allowed: number): void {
  if (regression > allowed) failures.push(`${metric} regressed by ${regression.toFixed(4)}; allowed ${allowed.toFixed(4)}`);
}

function requireIncreaseRatio(failures: string[], metric: string, current: number, baseline: number, allowed: number): void {
  if (baseline <= 0) return;
  const increase = current / baseline - 1;
  if (increase > allowed) failures.push(`${metric} increased by ${(increase * 100).toFixed(2)}%; allowed ${(allowed * 100).toFixed(2)}%`);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
