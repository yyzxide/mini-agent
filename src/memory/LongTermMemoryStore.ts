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
import {
  createEmbeddingProviderFromEnvironment,
  type EmbeddingCacheStats,
  type EmbeddingProvider,
} from "./EmbeddingProvider.js";
import { planManualMemoryWrite, planSessionMemoryWrite } from "./MemoryPolicy.js";
import {
  HISTORICAL_MEMORY_KINDS,
  inferLegacyMemoryKind,
  inferLegacyMemoryScope,
  isMemoryKind,
  isMemoryScope,
  MEMORY_SCHEMA_VERSION,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type MemoryV2Fields,
} from "./MemoryTypes.js";

export type LongTermMemorySource = "TASK_SUMMARY" | "MEMORY_COMPACTION" | "MANUAL";
type IndexedSessionMemorySource = Exclude<LongTermMemorySource, "MANUAL">;

export interface LongTermMemoryEntry extends MemoryV2Fields {
  schemaVersion: 2;
  kind: MemoryKind;
  scope: MemoryScope;
  subject: string;
  status: MemoryStatus;
  evidenceRefs: string[];
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
  excludeSessionId?: string;
  allowedKinds?: MemoryKind[];
  allowedScopes?: MemoryScope[];
  minRerankScore?: number;
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
  byKind: Record<MemoryKind, number>;
  byScope: Record<MemoryScope, number>;
  schemaVersion: 2;
}

export interface LongTermMemoryMigrationResult {
  total: number;
  schemaMigrated: number;
  embeddingsMigrated: number;
  embeddingProvider: string;
}

const MEMORY_DIR = "memory";
const MEMORY_INDEX_FILE = "index.jsonl";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.06;
const DEFAULT_MAX_CANDIDATES = 40;
const DEFAULT_MIN_RERANK_SCORE = 0.12;
const MAX_INDEXED_TEXT_CHARS = 6000;
const MEMORY_LOCK_STALE_MS = 30_000;
const MEMORY_LOCK_TIMEOUT_MS = 5_000;

export class LongTermMemoryStore implements MemoryRetriever {
  private readonly repoPath: string;
  private readonly indexPath: string;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(options: { repoPath: string; embeddingProvider?: EmbeddingProvider }) {
    this.repoPath = options.repoPath;
    this.indexPath = resolveMiniAgentPath(this.repoPath, MEMORY_DIR, MEMORY_INDEX_FILE);
    this.embeddingProvider = options.embeddingProvider ?? createEmbeddingProviderFromEnvironment({ repoPath: options.repoPath });
  }

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.indexPath), 0o700);
    await fs.appendFile(this.indexPath, "", "utf8");
  }

  getEmbeddingCacheStats(): EmbeddingCacheStats | undefined {
    return this.embeddingProvider.getCacheStats?.();
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
    kind?: MemoryKind;
    scope?: MemoryScope;
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
    const writePlan = planManualMemoryWrite({
      text: `${title}\n${indexedText}`,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.ttlDays !== undefined ? { ttlDays: input.ttlDays } : {}),
    });
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
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: writePlan.kind ?? "PROJECT_CONVENTION",
      scope: writePlan.scope ?? "REPOSITORY",
      subject: title,
      status: "ACTIVE",
      evidenceRefs: writePlan.evidenceRefs ?? [],
      ...(writePlan.validUntil ? { validUntil: writePlan.validUntil, expiresAt: writePlan.validUntil } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { source: "manual", memoryWriteReason: writePlan.reason },
    };

    await this.withIndexLock(async () => {
      const entries = await this.readAll();
      const topicKey = normalizeMemoryTopic(title);
      for (const existing of entries) {
        if (existing.source === "MANUAL" && isMemoryActive(existing, Date.now()) && normalizeMemoryTopic(existing.title) === topicKey) {
          existing.status = "SUPERSEDED";
          existing.supersededBy = entry.id;
          existing.metadata.supersededBy = entry.id;
          entry.supersedes = existing.id;
          entry.metadata.supersedes = existing.id;
        }
      }
      entries.push(entry);
      await this.writeAll(entries);
    });
    return entry;
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    return await this.withIndexLock(async () => {
      const entries = await this.readAll();
      const removed = entries.find((entry) => entry.id === id);
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) {
        return false;
      }
      const predecessorId = removed?.supersedes
        ?? (typeof removed?.metadata.supersedes === "string" ? removed.metadata.supersedes : undefined);
      const predecessor = predecessorId ? next.find((entry) => entry.id === predecessorId) : undefined;
      if (predecessor && (predecessor.supersededBy === id || predecessor.metadata.supersededBy === id)) {
        predecessor.status = "ACTIVE";
        delete predecessor.supersededBy;
        delete predecessor.metadata.supersededBy;
        predecessor.updatedAt = new Date().toISOString();
      }
      await this.writeAll(next);
      return true;
    });
  }

  async clear(): Promise<number> {
    await this.init();
    return await this.withIndexLock(async () => {
      const entries = await this.readAll();
      await this.writeAll([]);
      return entries.length;
    });
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
    const byKind = Object.fromEntries([
      "USER_PREFERENCE", "PROJECT_CONVENTION", "ARCHITECTURE_DECISION", "SESSION_SUMMARY", "VERIFIED_OUTCOME", "ERROR_SOLUTION", "PLAN", "EPHEMERAL_FACT",
    ].map((kind) => [kind, 0])) as Record<MemoryKind, number>;
    const byScope: Record<MemoryScope, number> = { SESSION: 0, REPOSITORY: 0, USER: 0 };
    for (const entry of entries) {
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
      if (entry.kind) byKind[entry.kind] += 1;
      if (entry.scope) byScope[entry.scope] += 1;
    }
    return {
      total: entries.length,
      bySource,
      sessions: new Set(entries.map((entry) => entry.sessionId)).size,
      indexPath: this.indexPath,
      active: entries.filter((entry) => isMemoryActive(entry, now)).length,
      expired: entries.filter((entry) => isMemoryExpired(entry, now)).length,
      superseded: entries.filter((entry) => entry.status === "SUPERSEDED").length,
      embeddingProvider: this.embeddingProvider.id,
      byKind,
      byScope,
      schemaVersion: MEMORY_SCHEMA_VERSION,
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

    return await this.withIndexLock(async () => {
      const existing = await this.readAll();
      const nextById = new Map(existing.map((entry) => [entry.id, entry]));
      for (const entry of entries) {
        nextById.set(entry.id, entry);
      }

      const nextEntries = [...nextById.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      await this.writeAll(nextEntries);

      return { sessionId, indexed: entries.length, total: nextEntries.length };
    });
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
    const minRerankScore = options.minRerankScore ?? DEFAULT_MIN_RERANK_SCORE;
    const allowedKinds = new Set(options.allowedKinds ?? HISTORICAL_MEMORY_KINDS);
    const allowedScopes = new Set(options.allowedScopes ?? ["SESSION", "REPOSITORY", "USER"]);
    const queryVector = await this.embeddingProvider.embed(query.expandedQuery);
    const now = Date.now();
    const entries = (await this.readAll()).filter((entry) => (
      entry.metadata.success !== false
        && isMemoryActive(entry, now)
        && !isTransientDirectAnswer(entry)
        && entry.sessionId !== options.excludeSessionId
        && Boolean(entry.kind && allowedKinds.has(entry.kind))
        && Boolean(entry.scope && allowedScopes.has(entry.scope))
        && isCompatibleEmbedding(entry, this.embeddingProvider.id, queryVector.length)
    ));

    const candidates = entries
      .map((entry) => scoreMemoryEntry(entry, query, queryVector))
      .filter((result) => result.score >= minScore && hasRetrievalEvidence(result, this.embeddingProvider.id))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, maxCandidates));

    const reranked = rerankMemoryResults(candidates, query)
      .filter((result) => result.score >= minRerankScore);
    return selectMemoryEvidence(reranked, query, { ...options, limit });
  }

  async migrate(): Promise<LongTermMemoryMigrationResult> {
    await this.init();
    return await this.withIndexLock(async () => {
      const rawEntries = await readJsonLines<unknown>(this.indexPath);
      const entries = rawEntries.map((entry, index) => normalizeMemoryEntry(entry, index));
      let schemaMigrated = 0;
      let embeddingsMigrated = 0;
      for (let index = 0; index < entries.length; index += 1) {
        const raw = rawEntries[index] as { schemaVersion?: unknown } | undefined;
        if (raw?.schemaVersion !== MEMORY_SCHEMA_VERSION) schemaMigrated += 1;
        const entry = entries[index];
        if (!entry) continue;
        entry.vector = await this.embeddingProvider.embed(`${entry.title}\n${entry.text}`);
        entry.embeddingProvider = this.embeddingProvider.id;
        entry.updatedAt = new Date().toISOString();
        entry.metadata.embeddingMigratedAt = entry.updatedAt;
        embeddingsMigrated += 1;
      }
      await this.writeAll(entries);
      return { total: entries.length, schemaMigrated, embeddingsMigrated, embeddingProvider: this.embeddingProvider.id };
    });
  }

  private async readAll(): Promise<LongTermMemoryEntry[]> {
    return (await readJsonLines<unknown>(this.indexPath))
      .map((entry, index) => normalizeMemoryEntry(entry, index));
  }

  private async writeAll(entries: LongTermMemoryEntry[]): Promise<void> {
    await ensureDir(path.dirname(this.indexPath), 0o700);
    const tempPath = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await fs.writeFile(tempPath, jsonl.length > 0 ? `${jsonl}\n` : "", "utf8");
    await fs.rename(tempPath, this.indexPath);
  }

  private async withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.indexPath}.lock`;
    const startedAt = Date.now();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    while (!handle) {
      try {
        handle = await fs.open(lockPath, "wx");
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const stat = await fs.stat(lockPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > MEMORY_LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() - startedAt >= MEMORY_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for memory index lock: ${lockPath}`);
        }
        await delay(20);
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      void fs.utimes(lockPath, now, now).catch(() => undefined);
    }, Math.max(1_000, Math.floor(MEMORY_LOCK_STALE_MS / 3)));
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await handle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}

export function formatLongTermMemoryResults(results: LongTermMemorySearchResult[]): string {
  if (results.length === 0) {
    return "(none)";
  }

  return results.map((result, index) => {
    const preview = truncateText(result.entry.text.replace(/\s+/g, " "), 800);
    return [
      `[${index + 1}] score=${result.score.toFixed(3)} kind=${result.entry.kind} scope=${result.entry.scope} source=${result.entry.source} session=${result.entry.sessionId}`,
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

    const writePlan = planSessionMemoryWrite(record);
    if (!writePlan.store || !writePlan.kind || !writePlan.scope) {
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
      confidence: writePlan.confidence ?? 0.7,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: writePlan.kind,
      scope: writePlan.scope,
      subject: title,
      status: "ACTIVE",
      evidenceRefs: writePlan.evidenceRefs ?? [],
      ...(writePlan.validUntil ? { validUntil: writePlan.validUntil, expiresAt: writePlan.validUntil } : {}),
      createdAt: record.timestamp,
      updatedAt: record.timestamp,
      metadata: {
        ...pickMemoryMetadata(record.payload),
        memoryWriteReason: writePlan.reason,
      },
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

function isCompatibleEmbedding(entry: LongTermMemoryEntry, providerId: string, dimensions: number): boolean {
  const storedProviderId = entry.embeddingProvider ?? "local-hash-v2";
  return storedProviderId === providerId
    && entry.vector.length === dimensions
    && entry.vector.length > 0
    && entry.vector.every((item) => Number.isFinite(item));
}

function isMemoryExpired(entry: LongTermMemoryEntry, now: number): boolean {
  const expiry = entry.validUntil ?? entry.expiresAt;
  return Boolean(expiry && Date.parse(expiry) <= now);
}

function isMemoryActive(entry: LongTermMemoryEntry, now: number): boolean {
  return entry.status === "ACTIVE" && !isMemoryExpired(entry, now);
}

function isTransientDirectAnswer(entry: LongTermMemoryEntry): boolean {
  return entry.source === "TASK_SUMMARY" && entry.metadata.mode === "DIRECT_ANSWER";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function normalizeMemoryTopic(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasRetrievalEvidence(result: LongTermMemorySearchResult, providerId: string): boolean {
  return providerId !== "local-hash-v2" || result.matchedKeywords.length > 0;
}

function normalizeMemoryEntry(value: unknown, index: number): LongTermMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid memory entry at index ${index}: expected an object`);
  }
  const entry = value as Partial<LongTermMemoryEntry>;
  if (
    typeof entry.id !== "string"
    || typeof entry.sessionId !== "string"
    || typeof entry.repoPath !== "string"
    || !isMemorySource(entry.source)
    || typeof entry.title !== "string"
    || typeof entry.text !== "string"
    || !Array.isArray(entry.keywords)
    || !entry.keywords.every((item) => typeof item === "string")
    || !Array.isArray(entry.vector)
    || !entry.vector.every((item) => typeof item === "number" && Number.isFinite(item))
    || typeof entry.createdAt !== "string"
    || typeof entry.updatedAt !== "string"
  ) {
    throw new Error(`Invalid memory entry at index ${index}: required fields are malformed`);
  }
  const metadata = entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
    ? entry.metadata
    : {};
  const kind = isMemoryKind(entry.kind)
    ? entry.kind
    : inferLegacyMemoryKind({ source: entry.source, text: entry.text, metadata });
  const scope = isMemoryScope(entry.scope)
    ? entry.scope
    : inferLegacyMemoryScope({ source: entry.source, kind });
  const validUntil = typeof entry.validUntil === "string"
    ? entry.validUntil
    : typeof entry.expiresAt === "string" ? entry.expiresAt : undefined;
  const supersededBy = typeof entry.supersededBy === "string"
    ? entry.supersededBy
    : typeof metadata.supersededBy === "string" ? metadata.supersededBy : undefined;
  const supersedes = typeof entry.supersedes === "string"
    ? entry.supersedes
    : typeof metadata.supersedes === "string" ? metadata.supersedes : undefined;
  const expired = Boolean(validUntil && Date.parse(validUntil) <= Date.now());
  const status: MemoryStatus = entry.status === "ACTIVE" || entry.status === "SUPERSEDED" || entry.status === "EXPIRED"
    ? entry.status
    : supersededBy ? "SUPERSEDED" : expired ? "EXPIRED" : "ACTIVE";

  return {
    ...(entry as LongTermMemoryEntry),
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind,
    scope,
    subject: typeof entry.subject === "string" ? entry.subject : entry.title,
    status: expired && status === "ACTIVE" ? "EXPIRED" : status,
    evidenceRefs: Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((item): item is string => typeof item === "string")
      : [],
    ...(validUntil ? { validUntil } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    ...(supersedes ? { supersedes } : {}),
    metadata,
  };
}

function isMemorySource(value: unknown): value is LongTermMemorySource {
  return value === "TASK_SUMMARY" || value === "MEMORY_COMPACTION" || value === "MANUAL";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export { extractKeywords } from "./MemoryText.js";

export function redactMemoryText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}
