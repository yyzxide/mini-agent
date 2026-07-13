import fs from "node:fs/promises";
import { Command } from "commander";
import { loadAgentConfig } from "../config/AgentConfig.js";
import { evaluateRag } from "../rag/RagEvaluator.js";
import { RagStore } from "../rag/RagStore.js";
import type { RagEvalCase } from "../rag/RagTypes.js";
import { resolveRepoPath } from "../utils/fs.js";

interface SearchOptions {
  topK?: number;
  minScore?: number;
  source?: string;
  tag?: string[];
  maxContextChars?: number;
}

export function registerRagCommands(program: Command): void {
  const rag = program.command("rag").description("Manage and evaluate the repository-local RAG knowledge base");

  rag.command("ingest")
    .description("Index Markdown and text documents")
    .argument("<paths...>", "Repository-relative files or directories")
    .option("--chunk-size <number>", "Maximum characters per chunk", parsePositiveInteger)
    .option("--overlap <number>", "Approximate overlapping characters", parseNonNegativeInteger)
    .option("--tag <tag>", "Attach a filterable tag (repeatable)", collectValue, [])
    .action(async (paths: string[], options: { chunkSize?: number; overlap?: number; tag: string[] }) => {
      const store = await createConfiguredStore(process.cwd());
      writeJson(await store.ingest(paths, {
        ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
        ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
        tags: options.tag,
      }));
    });

  rag.command("search")
    .description("Search indexed knowledge with hybrid semantic and keyword retrieval")
    .argument("<query...>", "Question or search query")
    .option("--top-k <number>", "Maximum results", parsePositiveInteger)
    .option("--min-score <number>", "Minimum hybrid score", parseUnitNumber)
    .option("--source <path>", "Restrict results to a source or directory")
    .option("--tag <tag>", "Require a tag (repeatable)", collectValue, [])
    .option("--max-context-chars <number>", "Context character budget", parsePositiveInteger)
    .action(async (query: string[], options: SearchOptions) => {
      const store = await createConfiguredStore(process.cwd());
      writeJson(await store.search(query.join(" "), {
        ...(options.topK !== undefined ? { topK: options.topK } : {}),
        ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
        ...(options.source ? { source: options.source } : {}),
        ...(options.tag && options.tag.length > 0 ? { tags: options.tag } : {}),
        ...(options.maxContextChars !== undefined ? { maxContextChars: options.maxContextChars } : {}),
      }));
    });

  rag.command("stats").description("Show index statistics").action(async () => {
    writeJson(await (await createConfiguredStore(process.cwd())).stats());
  });

  rag.command("remove")
    .description("Remove all chunks for a source or directory prefix")
    .argument("<source>", "Indexed source path")
    .action(async (source: string) => writeJson({ removedChunks: await (await createConfiguredStore(process.cwd())).removeSource(source) }));

  rag.command("clear").description("Clear the local RAG index").action(async () => {
    writeJson({ removedChunks: await (await createConfiguredStore(process.cwd())).clear() });
  });

  rag.command("eval")
    .description("Evaluate retrieval against a JSON case dataset")
    .argument("<dataset>", "Repository-relative JSON dataset path")
    .action(async (dataset: string) => {
      const raw = JSON.parse(await fs.readFile(resolveRepoPath(process.cwd(), dataset), "utf8")) as unknown;
      const cases = parseEvalCases(raw);
      writeJson(await evaluateRag(await createConfiguredStore(process.cwd()), cases));
    });
}

async function createConfiguredStore(repoPath: string): Promise<RagStore> {
  const config = await loadAgentConfig(repoPath);
  return new RagStore({
    repoPath,
    ...(config.rag?.topK !== undefined ? { defaultTopK: config.rag.topK } : {}),
    ...(config.rag?.minScore !== undefined ? { defaultMinScore: config.rag.minScore } : {}),
    ...(config.rag?.maxContextChars !== undefined ? { defaultMaxContextChars: config.rag.maxContextChars } : {}),
  });
}

function parseEvalCases(value: unknown): RagEvalCase[] {
  const cases = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.cases) ? value.cases : undefined;
  if (!cases || cases.length === 0) throw new Error("RAG evaluation dataset must contain at least one case");
  return cases.map((entry, index) => {
    if (!isObject(entry) || typeof entry.query !== "string" || entry.query.trim().length === 0) {
      throw new Error(`Invalid RAG evaluation case at index ${index}: query is required`);
    }
    if (entry.relevantSources !== undefined && (!Array.isArray(entry.relevantSources) || entry.relevantSources.some((source) => typeof source !== "string"))) {
      throw new Error(`Invalid RAG evaluation case at index ${index}: relevantSources must be strings`);
    }
    return {
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      query: entry.query,
      ...(Array.isArray(entry.relevantSources) ? { relevantSources: entry.relevantSources as string[] } : {}),
      ...(typeof entry.expectNoAnswer === "boolean" ? { expectNoAnswer: entry.expectNoAnswer } : {}),
      ...(typeof entry.topK === "number" ? { topK: entry.topK } : {}),
    };
  });
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Expected a non-negative integer, received: ${value}`);
  return parsed;
}

function parseUnitNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`Expected a number from 0 to 1, received: ${value}`);
  return parsed;
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
