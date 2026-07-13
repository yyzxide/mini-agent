import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "../session/SessionStore.js";
import type { JsonObject, SessionRecord, SessionRecordType } from "../session/SessionTypes.js";
import { ensureDir, readJsonLines, resolveMiniAgentPath, truncateText } from "../utils/fs.js";
import { selectMemoryEvidence } from "./MemoryEvidenceSelector.js";
import { buildMemoryQuery, type MemoryQuery } from "./MemoryQueryBuilder.js";
import type { MemoryRetrievalOptions, MemoryRetriever } from "./MemoryRetriever.js";
import { rerankMemoryResults } from "./MemoryReranker.js";
import { cosineSimilarity, extractKeywords, unique } from "./MemoryText.js";
import { createEmbeddingProviderFromEnvironment, type EmbeddingProvider } from "./EmbeddingProvider.js";

export type LongTermMemorySource = "TASK_SUMMARY" | "MEMORY_COMPACTION" | "MANUAL";
type IndexedSessionMemorySource = Exclude<LongTermMemorySource, "MANUAL">;

export interface LongTermMemoryEntry {
  id: string;
  sessionId: string;
  repoPath: string;
  source: LongTermMemorySource;
  title: string;
  text: string;
  keywords: string[];
  vector: number[];
  embeddingProvider?: string;
  confidence?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export interface LongTermMemorySearchResult {
  entry: LongTermMemoryEntry;
  score: number;
  rawScore?: number;
  rerankScore?: number;
  keywordScore: number;
  vectorScore: number;
  matchedKeywords: string[];
  selectionReasons?: string[];
}

export interface LongTermMemoryIndexResult {
  sessionId: string;
  indexed: number;
  total: number;
}

export interface LongTermMemorySearchOptions {
  limit?: number;
  minScore?: number;
  sessionId?: string;
}

export interface LongTermMemoryStats {
  total: number;
  bySource: Record<LongTermMemorySource, number>;
  sessions: number;
  indexPath: string;
  active: number;
  expired: number;
  superseded: number;
  embeddingProvider: string;
}

const MEMORY_DIR = "memory";
const MEMORY_INDEX_FILE = "index.jsonl";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.06;
const DEFAULT_MAX_CANDIDATES = 40;
const MAX_INDEXED_TEXT_CHARS = 6000;

export class LongTermMemoryStore implements MemoryRetriever {
  private readonly repoPath: string;
  private readonly indexPath: string;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(options: { repoPath: string; embeddingProvider?: EmbeddingProvider }) {
    this.repoPath = options.repoPath;
    this.indexPath = resolveMiniAgentPath(this.repoPath, MEMORY_DIR, MEMORY_INDEX_FILE);
    this.embeddingProvider = options.embeddingProvider ?? createEmbeddingProviderFromEnvironment();
  }

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.indexPath));
    await fs.appendFile(this.indexPath, "", "utf8");
  }

  async list(limit = 50): Promise<LongTermMemoryEntry[]> {
    await this.init();
    const entries = await this.readAll();
    return entries
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(0, limit));
  }

  async remember(input: {
    text: string;
    title?: string;
    sessionId?: string;
    confidence?: number;
    ttlDays?: number;
  }): Promise<LongTermMemoryEntry> {
    await this.init();
    if (input.ttlDays !== undefined && (!Number.isFinite(input.ttlDays) || input.ttlDays <= 0)) {
      throw new Error("Memory ttlDays must be a positive number");
    }
    const text = redactMemoryText(input.text.trim());
    if (!text) {
      throw new Error("Memory text cannot be empty");
    }

    const title = redactMemoryText(input.title?.trim() || truncateText(text.replace(/\s+/g, " "), 120).text);
    const indexedText = truncateText(redactMemoryText(text), MAX_INDEXED_TEXT_CHARS).text;
    const timestamp = new Date().toISOString();
    const entry: LongTermMemoryEntry = {
      id: `manual:${randomUUID()}`,
      sessionId: input.sessionId?.trim() || "manual",
      repoPath: this.repoPath,
      source: "MANUAL",
      title,
      text: indexedText,
      keywords: extractKeywords(`${title}\n${indexedText}`).slice(0, 160),
      vector: await this.embeddingProvider.embed(`${title}\n${indexedText}`),
      embeddingProvider: this.embeddingProvider.id,
      confidence: clampConfidence(input.confidence ?? 1),
      ...(input.ttlDays !== undefined ? { expiresAt: new Date(Date.now() + input.ttlDays * 86_400_000).toISOString() } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { source: "manual" },
    };

    const entries = await this.readAll();
    const topicKey = normalizeMemoryTopic(title);
    for (const existing of entries) {
      if (existing.source === "MANUAL" && !existing.metadata.supersededBy && normalizeMemoryTopic(existing.title) === topicKey) {
        existing.metadata.supersededBy = entry.id;
        entry.metadata.supersedes = existing.id;
      }
    }
    entries.push(entry);
    await this.writeAll(entries);
    return entry;
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    const entries = await this.readAll();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) {
      return false;
    }
    await this.writeAll(next);
    return true;
  }

  async clear(): Promise<number> {
    await this.init();
    const entries = await this.readAll();
    await this.writeAll([]);
    return entries.length;
  }

  async stats(): Promise<LongTermMemoryStats> {
    await this.init();
    const entries = await this.readAll();
    const now = Date.now();
    const bySource: Record<LongTermMemorySource, number> = {
      TASK_SUMMARY: 0,
      MEMORY_COMPACTION: 0,
      MANUAL: 0,
    };
    for (const entry of entries) {
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    }
    return {
      total: entries.length,
      bySource,
      sessions: new Set(entries.map((entry) => entry.sessionId)).size,
      indexPath: this.indexPath,
      active: entries.filter((entry) => isMemoryActive(entry, now)).length,
      expired: entries.filter((entry) => isMemoryExpired(entry, now)).length,
      superseded: entries.filter((entry) => typeof entry.metadata.supersededBy === "string").length,
      embeddingProvider: this.embeddingProvider.id,
    };
  }

  async indexSession(sessionStore: SessionStore, sessionId: string): Promise<LongTermMemoryIndexResult> {
    await this.init();
    const meta = await sessionStore.getSessionMeta(sessionId);
    const records = await sessionStore.readRecords(sessionId);
    const entries = await extractMemoryEntries({
      records,
      sessionId,
      repoPath: meta.repoPath,
      title: meta.title,
    }, this.embeddingProvider);

    if (entries.length === 0) {
      return { sessionId, indexed: 0, total: (await this.readAll()).length };
    }

    const existing = await this.readAll();
    const nextById = new Map(existing.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      nextById.set(entry.id, entry);
    }

    const nextEntries = [...nextById.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    await this.writeAll(nextEntries);

    return {
      sessionId,
      indexed: entries.length,
      total: nextEntries.length,
    };
  }

  async search(query: string, options: LongTermMemorySearchOptions = {}): Promise<LongTermMemorySearchResult[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return [];
    }

    return await this.retrieve(buildMemoryQuery({
      query: trimmedQuery,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    }), options);
  }

  async retrieve(query: MemoryQuery, options: MemoryRetrievalOptions = {}): Promise<LongTermMemorySearchResult[]> {
    await this.init();
    if (query.expandedQuery.trim().length === 0) {
      return [];
    }

    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const queryVector = await this.embeddingProvider.embed(query.expandedQuery);
    const now = Date.now();
    const entries = (await this.readAll()).filter((entry) => entry.metadata.success !== false && isMemoryActive(entry, now));

    const candidates = entries
      .map((entry) => scoreMemoryEntry(entry, query, queryVector))
      .filter((result) => result.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, maxCandidates));

    const reranked = rerankMemoryResults(candidates, query);
    return selectMemoryEvidence(reranked, query, { ...options, limit });
  }

  private async readAll(): Promise<LongTermMemoryEntry[]> {
    return await readJsonLines<LongTermMemoryEntry>(this.indexPath);
  }

  private async writeAll(entries: LongTermMemoryEntry[]): Promise<void> {
    await ensureDir(path.dirname(this.indexPath));
    const tempPath = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await fs.writeFile(tempPath, jsonl.length > 0 ? `${jsonl}\n` : "", "utf8");
    await fs.rename(tempPath, this.indexPath);
  }
}

export function formatLongTermMemoryResults(results: LongTermMemorySearchResult[]): string {
  if (results.length === 0) {
    return "(none)";
  }

  return results.map((result, index) => {
    const preview = truncateText(result.entry.text.replace(/\s+/g, " "), 800);
    return [
      `[${index + 1}] score=${result.score.toFixed(3)} source=${result.entry.source} session=${result.entry.sessionId}`,
      `title: ${result.entry.title}`,
      `matched: ${result.matchedKeywords.length > 0 ? result.matchedKeywords.join(", ") : "(semantic only)"}`,
      `reason: ${result.selectionReasons && result.selectionReasons.length > 0 ? result.selectionReasons.join(", ") : "(none)"}`,
      `memory: ${preview.text}${preview.truncated ? "..." : ""}`,
    ].join("\n");
  }).join("\n\n");
}

async function extractMemoryEntries(input: {
  records: SessionRecord[];
  sessionId: string;
  repoPath: string;
  title: string;
}, embeddingProvider: EmbeddingProvider): Promise<LongTermMemoryEntry[]> {
  const entries: LongTermMemoryEntry[] = [];
  let latestUserMessage = "";

  for (const record of input.records) {
    if (record.type === "USER_MESSAGE") {
      latestUserMessage = readPayloadString(record.payload, "content");
      continue;
    }

    if (!isIndexableMemoryRecord(record)) {
      continue;
    }

    if (record.payload.success === false) {
      continue;
    }

    const text = readPayloadString(record.payload, "summary");
    if (text.length === 0) {
      continue;
    }

    const title = redactMemoryText(latestUserMessage.length > 0
      ? truncateText(latestUserMessage.replace(/\s+/g, " "), 120).text
      : input.title);
    const indexedText = truncateText(redactMemoryText(text), MAX_INDEXED_TEXT_CHARS).text;

    entries.push({
      id: `${input.sessionId}:${record.id}`,
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      source: record.type,
      title,
      text: indexedText,
      keywords: extractKeywords(`${title}\n${indexedText}`).slice(0, 160),
      vector: await embeddingProvider.embed(`${title}\n${indexedText}`),
      embeddingProvider: embeddingProvider.id,
      confidence: record.type === "MEMORY_COMPACTION" ? 0.85 : 0.75,
      createdAt: record.timestamp,
      updatedAt: record.timestamp,
      metadata: pickMemoryMetadata(record.payload),
    });
  }

  return entries;
}

function isIndexableMemoryRecord(record: SessionRecord): record is SessionRecord & { type: IndexedSessionMemorySource } {
  return isIndexableMemoryType(record.type);
}

function isIndexableMemoryType(type: SessionRecordType): type is IndexedSessionMemorySource {
  return type === "TASK_SUMMARY" || type === "MEMORY_COMPACTION";
}

function readPayloadString(payload: JsonObject, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function pickMemoryMetadata(payload: JsonObject): JsonObject {
  const metadata: JsonObject = {};
  for (const key of ["mode", "subMode", "success", "source", "evidenceFileCount"]) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function scoreMemoryEntry(
  entry: LongTermMemoryEntry,
  query: MemoryQuery,
  queryVector: number[],
): LongTermMemorySearchResult {
  const entryKeywords = new Set(entry.keywords);
  const matchedKeywords = unique(query.keywords.filter((keyword) => entryKeywords.has(keyword)));
  const keywordScore = query.keywords.length === 0
    ? 0
    : matchedKeywords.length / Math.max(1, Math.min(query.keywords.length, 12));
  const vectorScore = cosineSimilarity(queryVector, entry.vector);
  const confidence = clampConfidence(entry.confidence ?? 0.7);
  const score = Math.max(0, (vectorScore * 0.65 + keywordScore * 0.35) * (0.7 + confidence * 0.3));

  return {
    entry,
    score,
    rawScore: score,
    keywordScore,
    vectorScore,
    matchedKeywords,
  };
}

function isMemoryExpired(entry: LongTermMemoryEntry, now: number): boolean {
  return Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= now);
}

function isMemoryActive(entry: LongTermMemoryEntry, now: number): boolean {
  return !isMemoryExpired(entry, now) && typeof entry.metadata.supersededBy !== "string";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function normalizeMemoryTopic(value: string): string {
  return extractKeywords(value).slice(0, 12).sort().join("|") || value.trim().toLowerCase();
}

export { extractKeywords } from "./MemoryText.js";

export function redactMemoryText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}
