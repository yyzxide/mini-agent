import path from "node:path";
import type { Command } from "commander";
import { loadAgentConfig, resolveLlmConfig } from "../config/AgentConfig.js";
import { AgentBench } from "../eval/AgentBench.js";
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
      const dataset = await loadAgentBenchDataset(resolveRepoPath(repoPath, datasetPath));
      const baseline = options.baseline
        ? await loadAgentBenchReport(resolveRepoPath(repoPath, options.baseline))
        : undefined;
      const resolved = options.mode === "real"
        ? resolveLlmConfig(await loadAgentConfig(repoPath), { model: options.model, baseUrl: options.baseUrl }).openai
        : undefined;
      const report = await new AgentBench().run(dataset, {
        mode: options.mode,
        ...(options.repetitions !== undefined ? { repetitions: options.repetitions } : {}),
        ...(resolved?.model ? { model: resolved.model } : {}),
        ...(baseline ? { baseline } : {}),
        keepRepos: options.keepRepos === true,
        ...(resolved ? { createLlmClient: () => new OpenAICompatibleClient(resolved) } : {}),
      });

      if (options.output) {
        const outputPath = resolveRepoPath(repoPath, options.output);
        await ensureDir(path.dirname(outputPath));
        await writeJsonFileAtomic(outputPath, report);
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.gate.passed && options.failOnRegression) process.exitCode = 1;
    });
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
