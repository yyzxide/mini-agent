import fs from "node:fs/promises";
import path from "node:path";
import {
  createEmbeddingProviderFromEnvironment,
  type EmbeddingCacheStats,
  type EmbeddingProvider,
} from "../memory/EmbeddingProvider.js";
import { cosineSimilarity, extractKeywords, unique } from "../memory/MemoryText.js";
import { ensureDir, readJsonLines, resolveMiniAgentPath, truncateText } from "../utils/fs.js";
import { RagDocumentLoader } from "./DocumentLoader.js";
import { hashText } from "./DocumentLoader.js";
import type {
  RagChunk,
  RagIngestResult,
  RagSearchOptions,
  RagSearchResponse,
  RagSearchResult,
  RagStats,
} from "./RagTypes.js";
import { chunkText } from "./TextChunker.js";

const RAG_INDEX_PATH = ["rag", "index.jsonl"] as const;
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 180;
const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.12;
const DEFAULT_MAX_CONTEXT_CHARS = 6000;
const MAX_RESULTS_PER_SOURCE = 2;

export class RagStore {
  private readonly indexPath: string;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly defaults: Required<Pick<RagSearchOptions, "topK" | "minScore" | "maxContextChars">>;

  constructor(options: {
    repoPath: string;
    embeddingProvider?: EmbeddingProvider;
    defaultTopK?: number;
    defaultMinScore?: number;
    defaultMaxContextChars?: number;
  }) {
    this.indexPath = resolveMiniAgentPath(options.repoPath, ...RAG_INDEX_PATH);
    this.embeddingProvider = options.embeddingProvider ?? createEmbeddingProviderFromEnvironment({ repoPath: options.repoPath });
    this.defaults = {
      topK: options.defaultTopK ?? DEFAULT_TOP_K,
      minScore: options.defaultMinScore ?? DEFAULT_MIN_SCORE,
      maxContextChars: options.defaultMaxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS,
    };
    this.repoPath = options.repoPath;
  }

  private readonly repoPath: string;

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.indexPath), 0o700);
    await fs.appendFile(this.indexPath, "", "utf8");
  }

  getEmbeddingCacheStats(): EmbeddingCacheStats | undefined {
    return this.embeddingProvider.getCacheStats?.();
  }

  async ingest(inputPaths: string[], options: {
    chunkSize?: number;
    overlap?: number;
    tags?: string[];
    maxFileBytes?: number;
  } = {}): Promise<RagIngestResult> {
    await this.init();
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const overlap = options.overlap ?? DEFAULT_OVERLAP;
    const loader = new RagDocumentLoader({
      repoPath: this.repoPath,
      ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
    });
    const loaded = await loader.load(inputPaths, options.tags);
    const existing = await this.readAll();
    let next = [...existing];
    let unchangedFiles = 0;
    let indexedFiles = 0;
    let indexedChunks = 0;
    let replacedChunks = 0;

    for (const document of loaded.documents) {
      const sourceChunks = existing.filter((chunk) => chunk.source === document.source);
      if (isDocumentCurrent(sourceChunks, document.sourceHash, document.tags, this.embeddingProvider.id, chunkSize, overlap)) {
        unchangedFiles += 1;
        continue;
      }

      replacedChunks += next.filter((chunk) => chunk.source === document.source).length;
      next = next.filter((chunk) => chunk.source !== document.source);
      const timestamp = new Date().toISOString();
      const drafts = chunkText(document.text, { chunkSize, overlap });
      for (const draft of drafts) {
        const embeddingText = [document.title, draft.heading, draft.text].filter(Boolean).join("\n");
        const contentHash = hashText(draft.text);
        next.push({
          ...draft,
          id: hashText(`${document.source}:${draft.startLine}:${draft.endLine}:${contentHash}`),
          source: document.source,
          title: document.title,
          sourceHash: document.sourceHash,
          contentHash,
          tags: document.tags,
          keywords: extractKeywords(embeddingText).slice(0, 160),
          vector: await this.embeddingProvider.embed(embeddingText),
          embeddingProvider: this.embeddingProvider.id,
          createdAt: timestamp,
          updatedAt: timestamp,
          metadata: { chunkSize, overlap },
        });
      }
      indexedFiles += 1;
      indexedChunks += drafts.length;
    }

    next.sort((left, right) => left.source.localeCompare(right.source) || left.chunkIndex - right.chunkIndex);
    if (indexedFiles > 0) await this.writeAll(next);
    return {
      inputPaths,
      discoveredFiles: loaded.documents.length,
      indexedFiles,
      unchangedFiles,
      indexedChunks,
      replacedChunks,
      totalChunks: next.length,
      skipped: loaded.skipped,
      indexPath: this.indexPath,
      embeddingProvider: this.embeddingProvider.id,
    };
  }

  async search(query: string, options: RagSearchOptions = {}): Promise<RagSearchResponse> {
    await this.init();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return this.emptyResponse(query, "EMPTY_QUERY");
    const allChunks = await this.readAll();
    if (allChunks.length === 0) return this.emptyResponse(trimmedQuery, "EMPTY_INDEX");

    const normalizedTags = normalizeTags(options.tags ?? []);
    const candidates = allChunks.filter((chunk) =>
      chunk.embeddingProvider === this.embeddingProvider.id
      && (!options.source || sourceMatches(chunk.source, options.source))
      && normalizedTags.every((tag) => chunk.tags.includes(tag))
    );
    if (candidates.length === 0 && allChunks.every((chunk) => chunk.embeddingProvider !== this.embeddingProvider.id)) {
      return this.emptyResponse(trimmedQuery, "EMBEDDING_PROVIDER_MISMATCH");
    }

    const topK = clampInteger(options.topK ?? this.defaults.topK, 1, 20);
    const minScore = clampNumber(options.minScore ?? this.defaults.minScore, 0, 1);
    const maxContextChars = clampInteger(options.maxContextChars ?? this.defaults.maxContextChars, 200, 30_000);
    const queryVector = await this.embeddingProvider.embed(trimmedQuery);
    const queryKeywords = extractKeywords(trimmedQuery);
    const scored = candidates
      .map((chunk) => scoreChunk(chunk, trimmedQuery, queryKeywords, queryVector))
      .filter((result) => result.score >= minScore && (!this.embeddingProvider.id.startsWith("local-hash-") || passesLocalHashEvidenceGate(result, queryKeywords)))
      .sort((left, right) => right.score - left.score || left.chunk.source.localeCompare(right.chunk.source));
    const results = selectDiverseResults(scored, topK, maxContextChars).map(toPublicSearchResult);
    if (results.length === 0) return this.emptyResponse(trimmedQuery, "INSUFFICIENT_EVIDENCE");

    return {
      query: trimmedQuery,
      found: true,
      results,
      context: results.map((result, index) =>
        `[${index + 1}] ${result.citation}\n${result.chunk.text}`
      ).join("\n\n"),
      citations: unique(results.map((result) => result.citation)),
      embeddingProvider: this.embeddingProvider.id,
    };
  }

  async removeSource(source: string): Promise<number> {
    await this.init();
    const entries = await this.readAll();
    const next = entries.filter((entry) => !sourceMatches(entry.source, source));
    if (next.length !== entries.length) await this.writeAll(next);
    return entries.length - next.length;
  }

  async clear(): Promise<number> {
    await this.init();
    const entries = await this.readAll();
    await this.writeAll([]);
    return entries.length;
  }

  async stats(): Promise<RagStats> {
    await this.init();
    const entries = await this.readAll();
    return {
      totalChunks: entries.length,
      sources: new Set(entries.map((entry) => entry.source)).size,
      bySource: countValues(entries.map((entry) => entry.source)),
      byEmbeddingProvider: countValues(entries.map((entry) => entry.embeddingProvider)),
      tags: countValues(entries.flatMap((entry) => entry.tags)),
      indexPath: this.indexPath,
      activeEmbeddingProvider: this.embeddingProvider.id,
    };
  }

  private emptyResponse(query: string, reason: NonNullable<RagSearchResponse["reason"]>): RagSearchResponse {
    return { query, found: false, reason, results: [], context: "", citations: [], embeddingProvider: this.embeddingProvider.id };
  }

  private async readAll(): Promise<RagChunk[]> {
    return await readJsonLines<RagChunk>(this.indexPath);
  }

  private async writeAll(entries: RagChunk[]): Promise<void> {
    await ensureDir(path.dirname(this.indexPath), 0o700);
    const tempPath = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await fs.writeFile(tempPath, body ? `${body}\n` : "", "utf8");
    await fs.rename(tempPath, this.indexPath);
  }
}

function isDocumentCurrent(chunks: RagChunk[], sourceHash: string, tags: string[], provider: string, chunkSize: number, overlap: number): boolean {
  return chunks.length > 0 && chunks.every((chunk) =>
    chunk.sourceHash === sourceHash
    && chunk.embeddingProvider === provider
    && chunk.metadata.chunkSize === chunkSize
    && chunk.metadata.overlap === overlap
    && arraysEqual(chunk.tags, tags)
  );
}

type InternalSearchResult = Omit<RagSearchResult, "chunk"> & { chunk: RagChunk };

function scoreChunk(chunk: RagChunk, query: string, queryKeywords: string[], queryVector: number[]): InternalSearchResult {
  const vectorScore = Math.max(0, cosineSimilarity(queryVector, chunk.vector));
  const matchedKeywords = queryKeywords.filter((keyword) => chunk.keywords.includes(keyword));
  const keywordScore = queryKeywords.length > 0 ? matchedKeywords.length / queryKeywords.length : 0;
  const phraseBonus = chunk.text.toLowerCase().includes(query.toLowerCase()) ? 0.1 : 0;
  const score = Math.min(1, vectorScore * 0.7 + keywordScore * 0.3 + phraseBonus);
  return {
    chunk,
    score,
    vectorScore,
    keywordScore,
    matchedKeywords,
    citation: `${chunk.source}#L${chunk.startLine}-L${chunk.endLine}`,
    excerpt: truncateText(chunk.text.replace(/\s+/g, " "), 300).text,
  };
}

function selectDiverseResults(results: InternalSearchResult[], topK: number, maxChars: number): InternalSearchResult[] {
  const selected: InternalSearchResult[] = [];
  const sourceCounts = new Map<string, number>();
  let chars = 0;
  for (const result of results) {
    if ((sourceCounts.get(result.chunk.source) ?? 0) >= MAX_RESULTS_PER_SOURCE) continue;
    const addition = result.chunk.text.length + result.citation.length + 12;
    if (selected.length > 0 && chars + addition > maxChars) continue;
    selected.push(result);
    chars += addition;
    sourceCounts.set(result.chunk.source, (sourceCounts.get(result.chunk.source) ?? 0) + 1);
    if (selected.length >= topK) break;
  }
  return selected;
}

function toPublicSearchResult(result: InternalSearchResult): RagSearchResult {
  const chunk = result.chunk;
  return {
    score: result.score,
    vectorScore: result.vectorScore,
    keywordScore: result.keywordScore,
    matchedKeywords: result.matchedKeywords,
    citation: result.citation,
    excerpt: result.excerpt,
    chunk: {
      id: chunk.id,
      source: chunk.source,
      title: chunk.title,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkIndex: chunk.chunkIndex,
      ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
      tags: chunk.tags,
    },
  };
}

function passesLocalHashEvidenceGate(result: InternalSearchResult, queryKeywords: string[]): boolean {
  const requiredMatches = queryKeywords.length <= 2 ? 1 : 2;
  return result.matchedKeywords.length >= requiredMatches && result.keywordScore >= 0.1;
}

function sourceMatches(source: string, filter: string): boolean {
  const normalized = filter.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return source === normalized || source.startsWith(`${normalized}/`);
}

function normalizeTags(tags: string[]): string[] {
  return unique(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)).sort();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new Error(`Expected integer between ${min} and ${max}`);
  return Math.max(min, Math.min(max, value));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new Error(`Expected number between ${min} and ${max}`);
  return Math.max(min, Math.min(max, value));
}
