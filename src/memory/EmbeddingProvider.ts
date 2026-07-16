import { createHash } from "node:crypto";
import path from "node:path";
import { embedText } from "./MemoryText.js";
import { ensureDir, readJsonFile, resolveMiniAgentPath, writeJsonFileAtomic } from "../utils/fs.js";

export interface EmbeddingProvider {
  readonly id: string;
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingCacheStats {
  memoryHits: number;
  diskHits: number;
  misses: number;
  writes: number;
  coalescedRequests: number;
}

interface EmbeddingCacheRecord {
  version: 1;
  providerId: string;
  textHash: string;
  vector: number[];
  createdAt: string;
}

const EMBEDDING_CACHE_VERSION = 1;
const DEFAULT_MEMORY_CACHE_ENTRIES = 256;

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "local-hash-v2";
  async embed(text: string): Promise<number[]> { return embedText(text); }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
  }) {
    const endpointNamespace = sha256(options.baseUrl.replace(/\/+$/, "")).slice(0, 16);
    this.id = `openai-compatible:${options.model}:${endpointNamespace}`;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({ model: this.options.model, input: text }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.every((item) => typeof item === "number")) {
      throw new Error("Embedding API returned an invalid vector");
    }
    return vector;
  }
}

export class CachedEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly cacheDirectory: string;
  private readonly maxMemoryEntries: number;
  private readonly memoryCache = new Map<string, number[]>();
  private readonly inFlight = new Map<string, Promise<number[]>>();
  private readonly stats: EmbeddingCacheStats = {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    writes: 0,
    coalescedRequests: 0,
  };

  constructor(private readonly options: {
    repoPath: string;
    provider: EmbeddingProvider;
    maxMemoryEntries?: number;
  }) {
    this.id = options.provider.id;
    this.maxMemoryEntries = options.maxMemoryEntries ?? DEFAULT_MEMORY_CACHE_ENTRIES;
    if (!Number.isInteger(this.maxMemoryEntries) || this.maxMemoryEntries <= 0) {
      throw new Error("Embedding memory cache size must be a positive integer");
    }

    const providerHash = sha256(this.id);
    this.cacheDirectory = resolveMiniAgentPath(
      options.repoPath,
      "cache",
      "embeddings",
      `v${EMBEDDING_CACHE_VERSION}`,
      providerHash,
    );
  }

  getStats(): EmbeddingCacheStats {
    return { ...this.stats };
  }

  async embed(text: string): Promise<number[]> {
    const textHash = sha256(text);
    const memoryHit = this.readMemory(textHash);
    if (memoryHit) {
      this.stats.memoryHits += 1;
      return memoryHit;
    }

    const pending = this.inFlight.get(textHash);
    if (pending) {
      this.stats.coalescedRequests += 1;
      return [...await pending];
    }

    const request = this.loadOrCreate(text, textHash);
    this.inFlight.set(textHash, request);
    try {
      return [...await request];
    } finally {
      if (this.inFlight.get(textHash) === request) {
        this.inFlight.delete(textHash);
      }
    }
  }

  private async loadOrCreate(text: string, textHash: string): Promise<number[]> {
    const cachePath = path.join(this.cacheDirectory, `${textHash}.json`);
    const cached = await readJsonFile<unknown>(cachePath, undefined).catch(() => undefined);
    if (isValidCacheRecord(cached, this.id, textHash)) {
      this.stats.diskHits += 1;
      this.remember(textHash, cached.vector);
      return [...cached.vector];
    }

    this.stats.misses += 1;
    const vector = await this.options.provider.embed(text);
    assertValidVector(vector);
    this.remember(textHash, vector);

    const record: EmbeddingCacheRecord = {
      version: EMBEDDING_CACHE_VERSION,
      providerId: this.id,
      textHash,
      vector: [...vector],
      createdAt: new Date().toISOString(),
    };
    await ensureDir(this.cacheDirectory)
      .then(async () => await writeJsonFileAtomic(cachePath, record))
      .then(() => { this.stats.writes += 1; })
      .catch(() => undefined);
    return [...vector];
  }

  private readMemory(textHash: string): number[] | undefined {
    const vector = this.memoryCache.get(textHash);
    if (!vector) {
      return undefined;
    }

    this.memoryCache.delete(textHash);
    this.memoryCache.set(textHash, vector);
    return [...vector];
  }

  private remember(textHash: string, vector: number[]): void {
    this.memoryCache.delete(textHash);
    this.memoryCache.set(textHash, [...vector]);
    while (this.memoryCache.size > this.maxMemoryEntries) {
      const oldest = this.memoryCache.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.memoryCache.delete(oldest);
    }
  }
}

export function createEmbeddingProviderFromEnvironment(options: { repoPath?: string } = {}): EmbeddingProvider {
  const model = process.env.MINI_AGENT_EMBEDDING_MODEL;
  const apiKey = process.env.MINI_AGENT_EMBEDDING_API_KEY ?? process.env.MINI_AGENT_API_KEY;
  const baseUrl = process.env.MINI_AGENT_EMBEDDING_BASE_URL ?? process.env.MINI_AGENT_BASE_URL;
  if (!model || !apiKey || !baseUrl) {
    return new LocalHashEmbeddingProvider();
  }

  const provider = new OpenAICompatibleEmbeddingProvider({ model, apiKey, baseUrl });
  return options.repoPath
    ? new CachedEmbeddingProvider({ repoPath: options.repoPath, provider })
    : provider;
}

function isValidCacheRecord(value: unknown, providerId: string, textHash: string): value is EmbeddingCacheRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<EmbeddingCacheRecord>;
  return record.version === EMBEDDING_CACHE_VERSION
    && record.providerId === providerId
    && record.textHash === textHash
    && isValidVector(record.vector);
}

function assertValidVector(value: unknown): asserts value is number[] {
  if (!isValidVector(value)) {
    throw new Error("Embedding provider returned an invalid vector");
  }
}

function isValidVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
