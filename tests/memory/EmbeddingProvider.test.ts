import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CachedEmbeddingProvider,
  createEmbeddingProviderFromEnvironment,
  type EmbeddingProvider,
} from "../../src/memory/EmbeddingProvider.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-embedding-cache-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("CachedEmbeddingProvider", () => {
  it("reuses embeddings in memory and across provider instances without storing source text", async () => {
    let calls = 0;
    const delegate: EmbeddingProvider = {
      id: "remote-fixture-v1",
      embed: async (text) => {
        calls += 1;
        return [text.length, 1];
      },
    };
    const first = new CachedEmbeddingProvider({ repoPath, provider: delegate });
    const sourceText = "private policy text";

    expect(await first.embed(sourceText)).toEqual([sourceText.length, 1]);
    expect(await first.embed(sourceText)).toEqual([sourceText.length, 1]);
    expect(calls).toBe(1);
    expect(first.getStats()).toMatchObject({ misses: 1, writes: 1, memoryHits: 1 });

    const second = new CachedEmbeddingProvider({ repoPath, provider: delegate });
    expect(await second.embed(sourceText)).toEqual([sourceText.length, 1]);
    expect(calls).toBe(1);
    expect(second.getStats()).toMatchObject({ diskHits: 1, misses: 0 });

    const cacheFiles = await listFiles(path.join(repoPath, ".mini-agent", "cache"));
    const cacheBody = await fs.readFile(cacheFiles.find((file) => file.endsWith(".json"))!, "utf8");
    expect(cacheBody).not.toContain(sourceText);
  });

  it("isolates vector spaces by provider id and repairs corrupt entries", async () => {
    let firstCalls = 0;
    const firstProvider: EmbeddingProvider = {
      id: "provider-a",
      embed: async () => { firstCalls += 1; return [1, 0]; },
    };
    await new CachedEmbeddingProvider({ repoPath, provider: firstProvider }).embed("same text");
    const firstCachePath = (await listFiles(path.join(repoPath, ".mini-agent", "cache")))
      .find((file) => file.endsWith(".json"));
    expect(firstCachePath).toBeDefined();

    let secondCalls = 0;
    const secondProvider: EmbeddingProvider = {
      id: "provider-b",
      embed: async () => { secondCalls += 1; return [0, 1]; },
    };
    expect(await new CachedEmbeddingProvider({ repoPath, provider: secondProvider }).embed("same text"))
      .toEqual([0, 1]);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);

    await fs.writeFile(firstCachePath!, "not-json", "utf8");

    const repaired = new CachedEmbeddingProvider({ repoPath, provider: firstProvider });
    await expect(repaired.embed("same text")).resolves.toEqual([1, 0]);
    expect(firstCalls).toBe(2);
    await expect(fs.readFile(firstCachePath!, "utf8")).resolves.toContain('"providerId": "provider-a"');
  });

  it("coalesces concurrent requests and never caches failures", async () => {
    let calls = 0;
    const provider: EmbeddingProvider = {
      id: "single-flight-provider",
      embed: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (calls === 1) {
          throw new Error("temporary embedding failure");
        }
        return [1, 2, 3];
      },
    };
    const cached = new CachedEmbeddingProvider({ repoPath, provider });

    await expect(Promise.all([cached.embed("query"), cached.embed("query")]))
      .rejects.toThrow("temporary embedding failure");
    expect(calls).toBe(1);
    await expect(Promise.all([cached.embed("query"), cached.embed("query"), cached.embed("query")]))
      .resolves.toEqual([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    expect(calls).toBe(2);
    expect(cached.getStats().coalescedRequests).toBe(3);
  });

  it("automatically wraps configured remote embeddings with the repository cache", async () => {
    const previous = snapshotEmbeddingEnvironment();
    process.env.MINI_AGENT_EMBEDDING_MODEL = "embedding-model";
    process.env.MINI_AGENT_EMBEDDING_API_KEY = "test-key";
    process.env.MINI_AGENT_EMBEDDING_BASE_URL = "https://embedding.example/v1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [0.25, 0.75] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const first = createEmbeddingProviderFromEnvironment({ repoPath });
      const second = createEmbeddingProviderFromEnvironment({ repoPath });
      await expect(first.embed("cached query")).resolves.toEqual([0.25, 0.75]);
      await expect(second.embed("cached query")).resolves.toEqual([0.25, 0.75]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restoreEmbeddingEnvironment(previous);
    }
  });
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? await listFiles(target) : [target];
  }));
  return files.flat();
}

function snapshotEmbeddingEnvironment(): Record<string, string | undefined> {
  return {
    MINI_AGENT_EMBEDDING_MODEL: process.env.MINI_AGENT_EMBEDDING_MODEL,
    MINI_AGENT_EMBEDDING_API_KEY: process.env.MINI_AGENT_EMBEDDING_API_KEY,
    MINI_AGENT_EMBEDDING_BASE_URL: process.env.MINI_AGENT_EMBEDDING_BASE_URL,
  };
}

function restoreEmbeddingEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
