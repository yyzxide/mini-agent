import type { AgentHarnessMetrics, AgentHarnessScenario } from "./AgentHarness.js";

export type AgentBenchMode = "scripted" | "real";

export interface AgentBenchThresholds {
  minPassAt1?: number;
  minPassAtK?: number;
  minRunPassRate?: number;
  minToolChoiceAccuracy?: number;
  maxAverageSteps?: number;
  maxAverageLlmCalls?: number;
  maxAverageTotalTokens?: number;
  maxAverageDurationMs?: number;
  maxContextTruncationRate?: number;
}

export interface AgentBenchBaselinePolicy {
  maxPassAt1Regression?: number;
  maxRunPassRateRegression?: number;
  maxAverageStepsIncreaseRatio?: number;
  maxAverageLlmCallsIncreaseRatio?: number;
  maxAverageTotalTokensIncreaseRatio?: number;
}

export interface AgentBenchDataset {
  version: 1;
  name: string;
  description?: string;
  repetitions?: number;
  thresholds?: AgentBenchThresholds;
  baselinePolicy?: AgentBenchBaselinePolicy;
  scenarios: AgentHarnessScenario[];
}

export interface AgentBenchRunResult {
  scenarioId: string;
  scenarioName: string;
  repetition: number;
  passed: boolean;
  success: boolean;
  summary: string;
  error?: string;
  expectationFailures: string[];
  metrics: AgentHarnessMetrics;
  repoPath?: string;
}

export interface AgentBenchScenarioSummary {
  scenarioId: string;
  scenarioName: string;
  runs: number;
  passed: number;
  passRate: number;
  passedAtLeastOnce: boolean;
  firstRunPassed: boolean;
}

export interface AgentBenchSummary {
  scenarios: number;
  totalRuns: number;
  passedRuns: number;
  passAt1: number;
  passAtK: number;
  runPassRate: number;
  toolChoiceAccuracy: number;
  averageSteps: number;
  averageLlmCalls: number;
  averageDurationMs: number;
  averageTotalTokens: number;
  averageCachedPromptTokens: number;
  contextTruncationRate: number;
  failuresByCategory: Record<string, number>;
}

export interface AgentBenchGateResult {
  passed: boolean;
  failures: string[];
  comparedToBaseline: boolean;
}

export interface AgentBenchReport {
  version: 1;
  dataset: string;
  mode: AgentBenchMode;
  model?: string;
  startedAt: string;
  finishedAt: string;
  repetitions: number;
  summary: AgentBenchSummary;
  scenarios: AgentBenchScenarioSummary[];
  runs: AgentBenchRunResult[];
  gate: AgentBenchGateResult;
}
