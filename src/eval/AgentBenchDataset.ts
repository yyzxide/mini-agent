import fs from "node:fs/promises";
import { z } from "zod";
import { AgentDecisionSchema } from "../agent/AgentDecision.js";
import type { AgentBenchDataset, AgentBenchReport } from "./AgentBenchTypes.js";

const probabilitySchema = z.number().min(0).max(1);
const nonNegativeSchema = z.number().finite().min(0);

const expectedSchema = z.object({
  success: z.boolean().optional(),
  diffContains: z.array(z.string()).optional(),
  diffNotContains: z.array(z.string()).optional(),
  filesExist: z.array(z.string().trim().min(1)).optional(),
  filesContain: z.record(z.string(), z.string()).optional(),
  filesNotContain: z.record(z.string(), z.string()).optional(),
  toolsCalled: z.array(z.string().min(1)).optional(),
  toolCallsInOrder: z.array(z.object({
    name: z.string().trim().min(1),
    inputContains: z.record(z.string(), z.unknown()).optional(),
  }).strict()).optional(),
  testsPassed: z.boolean().optional(),
  verificationPassed: z.boolean().optional(),
  maxSteps: z.number().int().positive().optional(),
  maxLlmCalls: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().nonnegative().optional(),
  summaryContains: z.array(z.string()).optional(),
  summaryNotContains: z.array(z.string()).optional(),
  summaryMatches: z.array(z.string().refine((value) => {
    try {
      new RegExp(value, "iu");
      return true;
    } catch {
      return false;
    }
  }, "Invalid regular expression")).optional(),
}).strict();

const scenarioSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  userGoal: z.string().trim().min(1),
  files: z.record(z.string(), z.string()).optional(),
  untrackedFiles: z.record(z.string(), z.string()).optional(),
  ragIndexPaths: z.array(z.string().trim().min(1)).min(1).optional(),
  postIndexFiles: z.record(z.string(), z.string()).optional(),
  decisions: z.array(AgentDecisionSchema).min(1).optional(),
  maxSteps: z.number().int().positive().optional(),
  operatingMode: z.enum(["EXECUTE", "PLAN"]).optional(),
  expected: expectedSchema.optional(),
}).strict();

const thresholdsSchema = z.object({
  minPassAt1: probabilitySchema.optional(),
  minPassAtK: probabilitySchema.optional(),
  minRunPassRate: probabilitySchema.optional(),
  minToolChoiceAccuracy: probabilitySchema.optional(),
  minAllRunsPassRate: probabilitySchema.optional(),
  maxFlakyScenarios: z.number().int().nonnegative().optional(),
  maxAverageSteps: nonNegativeSchema.optional(),
  maxAverageLlmCalls: nonNegativeSchema.optional(),
  maxAverageTotalTokens: nonNegativeSchema.optional(),
  maxAverageDurationMs: nonNegativeSchema.optional(),
  maxContextTruncationRate: probabilitySchema.optional(),
}).strict();

const baselinePolicySchema = z.object({
  maxPassAt1Regression: probabilitySchema.optional(),
  maxRunPassRateRegression: probabilitySchema.optional(),
  maxAllRunsPassRateRegression: probabilitySchema.optional(),
  maxToolChoiceAccuracyRegression: probabilitySchema.optional(),
  maxAverageStepsIncreaseRatio: nonNegativeSchema.optional(),
  maxAverageLlmCallsIncreaseRatio: nonNegativeSchema.optional(),
  maxAverageTotalTokensIncreaseRatio: nonNegativeSchema.optional(),
}).strict();

const datasetSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  repetitions: z.number().int().positive().max(20).optional(),
  thresholds: thresholdsSchema.optional(),
  baselinePolicy: baselinePolicySchema.optional(),
  scenarios: z.array(scenarioSchema).min(1),
}).strict();

export async function loadAgentBenchDataset(filePath: string): Promise<AgentBenchDataset> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  const parsed = datasetSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid AgentBench dataset${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""}`);
  }
  const ids = new Set<string>();
  for (const [index, scenario] of parsed.data.scenarios.entries()) {
    const id = scenario.id ?? (slugify(scenario.name) || `scenario-${index + 1}`);
    if (ids.has(id)) throw new Error(`Invalid AgentBench dataset: duplicate scenario id ${id}`);
    ids.add(id);
    scenario.id = id;
  }
  return parsed.data as AgentBenchDataset;
}

export async function loadAgentBenchReport(filePath: string): Promise<AgentBenchReport> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isValidReport(value)) {
    throw new Error(`Invalid AgentBench baseline report: ${filePath}`);
  }
  return value;
}

function slugify(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isValidReport(value: unknown): value is AgentBenchReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (report.version !== 1 || typeof report.dataset !== "string" || (report.mode !== "scripted" && report.mode !== "real")) return false;
  if (!report.summary || typeof report.summary !== "object" || Array.isArray(report.summary)) return false;
  const summary = report.summary as Record<string, unknown>;
  const requiredSummaryNumbersValid = [
    "scenarios", "totalRuns", "passedRuns", "passAt1", "passAtK", "runPassRate", "toolChoiceAccuracy",
    "averageSteps", "averageLlmCalls", "averageDurationMs", "averageTotalTokens", "averageCachedPromptTokens", "contextTruncationRate",
  ].every((key) => typeof summary[key] === "number" && Number.isFinite(summary[key]));
  if (!requiredSummaryNumbersValid) return false;
  if (!optionalFiniteNumber(summary, "allRunsPassRate") || !optionalFiniteNumber(summary, "flakyScenarios")) return false;
  if (!Array.isArray(report.scenarios) || !Array.isArray(report.runs)) return false;
  if (typeof report.startedAt !== "string" || typeof report.finishedAt !== "string") return false;
  if (typeof report.repetitions !== "number" || !Number.isInteger(report.repetitions) || report.repetitions < 1) return false;
  return report.scenarios.every((scenario) => {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) return false;
    const entry = scenario as Record<string, unknown>;
    return typeof entry.scenarioId === "string"
      && typeof entry.scenarioName === "string"
      && typeof entry.passRate === "number"
      && Number.isFinite(entry.passRate);
  });
}

function optionalFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || (typeof value[key] === "number" && Number.isFinite(value[key]));
}
