import path from "node:path";
import fs from "node:fs/promises";
import type { Command } from "commander";
import { loadAgentConfig, resolveLlmConfig } from "../config/AgentConfig.js";
import { AgentBench, compareAgentBenchReports, renderAgentBenchMarkdownReport } from "../eval/AgentBench.js";
import { loadAgentBenchDataset, loadAgentBenchReport } from "../eval/AgentBenchDataset.js";
import type { AgentBenchMode } from "../eval/AgentBenchTypes.js";
import { OpenAICompatibleClient } from "../llm/OpenAICompatibleClient.js";
import { ensureDir, resolveRepoPath, writeJsonFileAtomic } from "../utils/fs.js";

interface BenchRunOptions {
  mode: AgentBenchMode;
  repetitions?: number;
  output?: string;
  baseline?: string;
  model?: string;
  baseUrl?: string;
  keepRepos?: boolean;
  failOnRegression: boolean;
}

interface BenchCompareOptions {
  output?: string;
}

interface BenchAcceptOptions {
  repetitions?: number;
  output: string;
  markdown: string;
  model?: string;
  baseUrl?: string;
  keepRepos?: boolean;
  failOnRegression: boolean;
}

const REAL_ACCEPTANCE_DATASET = "benchmarks/real-model-acceptance-v1.json";
const REAL_ACCEPTANCE_JSON = ".mini-agent/bench/real-model-acceptance-latest.json";
const REAL_ACCEPTANCE_MARKDOWN = ".mini-agent/bench/real-model-acceptance-latest.md";

export function registerBenchCommands(program: Command): void {
  const bench = program.command("bench").description("Run repeatable AgentBench quality and cost evaluations");

  bench.command("run")
    .description("Run an AgentBench JSON dataset with scripted or real model decisions")
    .argument("<dataset>", "Repository-relative AgentBench dataset path")
    .option("--mode <mode>", "scripted or real", parseBenchMode, "scripted")
    .option("--repetitions <number>", "Runs per scenario (1-20)", parseRepetitions)
    .option("--output <path>", "Write the JSON report to a repository-relative path")
    .option("--baseline <path>", "Compare against a previous AgentBench JSON report")
    .option("--model <model>", "Override the configured model in real mode")
    .option("--base-url <url>", "Override the configured OpenAI-compatible base URL in real mode")
    .option("--keep-repos", "Keep temporary scenario repositories for debugging")
    .option("--no-fail-on-regression", "Return success even when the quality gate fails")
    .action(async (datasetPath: string, options: BenchRunOptions) => {
      const repoPath = process.cwd();
      const report = await runBench(repoPath, datasetPath, options);
      if (options.output) await writeJsonReport(repoPath, options.output, report);
      finishBenchRun(report, options.failOnRegression);
    });

  bench.command("accept")
    .description("Run the versioned real-model acceptance suite and write JSON plus Markdown reports")
    .option("--repetitions <number>", "Runs per scenario (1-20)", parseRepetitions, 3)
    .option("--output <path>", "Write the JSON acceptance report", REAL_ACCEPTANCE_JSON)
    .option("--markdown <path>", "Write the human-readable Markdown acceptance report", REAL_ACCEPTANCE_MARKDOWN)
    .option("--model <model>", "Override the configured model")
    .option("--base-url <url>", "Override the configured OpenAI-compatible base URL")
    .option("--keep-repos", "Keep temporary scenario repositories for debugging")
    .option("--no-fail-on-regression", "Return success even when the acceptance gate fails")
    .action(async (options: BenchAcceptOptions) => {
      const repoPath = process.cwd();
      const report = await runBench(repoPath, REAL_ACCEPTANCE_DATASET, {
        mode: "real",
        output: options.output,
        failOnRegression: options.failOnRegression,
        ...(options.repetitions !== undefined ? { repetitions: options.repetitions } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.keepRepos !== undefined ? { keepRepos: options.keepRepos } : {}),
      });
      await writeJsonReport(repoPath, options.output, report);
      const markdownPath = resolveRepoPath(repoPath, options.markdown);
      await ensureDir(path.dirname(markdownPath));
      await fs.writeFile(markdownPath, renderAgentBenchMarkdownReport(report), "utf8");
      finishBenchRun(report, options.failOnRegression);
    });

  bench.command("compare")
    .description("Compare two stored AgentBench reports without rerunning scenarios")
    .argument("<current>", "Repository-relative current AgentBench report path")
    .argument("<baseline>", "Repository-relative baseline AgentBench report path")
    .option("--output <path>", "Write the comparison JSON to a repository-relative path")
    .action(async (currentPath: string, baselinePath: string, options: BenchCompareOptions) => {
      const repoPath = process.cwd();
      const current = await loadAgentBenchReport(resolveRepoPath(repoPath, currentPath));
      const baseline = await loadAgentBenchReport(resolveRepoPath(repoPath, baselinePath));
      const comparison = compareAgentBenchReports(current, baseline);
      if (options.output) {
        const outputPath = resolveRepoPath(repoPath, options.output);
        await ensureDir(path.dirname(outputPath));
        await writeJsonFileAtomic(outputPath, comparison);
      }
      process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    });
}

async function runBench(repoPath: string, datasetPath: string, options: BenchRunOptions) {
  const dataset = await loadAgentBenchDataset(resolveRepoPath(repoPath, datasetPath));
  const baseline = options.baseline
    ? await loadAgentBenchReport(resolveRepoPath(repoPath, options.baseline))
    : undefined;
  const resolved = options.mode === "real"
    ? resolveLlmConfig(await loadAgentConfig(repoPath), { model: options.model, baseUrl: options.baseUrl }).openai
    : undefined;
  return await new AgentBench().run(dataset, {
    mode: options.mode,
    ...(options.repetitions !== undefined ? { repetitions: options.repetitions } : {}),
    ...(resolved?.model ? { model: resolved.model } : {}),
    ...(baseline ? { baseline } : {}),
    keepRepos: options.keepRepos === true,
    ...(resolved ? { createLlmClient: () => new OpenAICompatibleClient(resolved) } : {}),
  });
}

async function writeJsonReport(repoPath: string, output: string, report: unknown): Promise<void> {
  const outputPath = resolveRepoPath(repoPath, output);
  await ensureDir(path.dirname(outputPath));
  await writeJsonFileAtomic(outputPath, report);
}

function finishBenchRun(report: Awaited<ReturnType<typeof runBench>>, failOnRegression: boolean): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.gate.passed && failOnRegression) process.exitCode = 1;
}

function parseBenchMode(value: string): AgentBenchMode {
  if (value !== "scripted" && value !== "real") throw new Error(`Expected scripted or real, received: ${value}`);
  return value;
}

function parseRepetitions(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error(`Expected an integer from 1 to 20, received: ${value}`);
  }
  return parsed;
}
