import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHashEmbeddingProvider, type EmbeddingProvider } from "../src/memory/EmbeddingProvider.js";
import { RagDocumentLoader } from "../src/rag/DocumentLoader.js";
import { evaluateRag } from "../src/rag/RagEvaluator.js";
import { RagStore } from "../src/rag/RagStore.js";
import { createDefaultToolRegistry } from "../src/tools/ToolRegistry.js";

class TestEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly id = "test-embedding-v1") {}

  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    return [
      normalized.includes("upload") || normalized.includes("分片") ? 1 : 0,
      normalized.includes("review") || normalized.includes("审核") ? 1 : 0,
      normalized.includes("permission") || normalized.includes("权限") ? 1 : 0,
    ];
  }
}

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-rag-"));
  await fs.mkdir(path.join(repoPath, "docs"));
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("RAG knowledge base", () => {
  it("ingests incrementally and replaces stale chunks when a source changes", async () => {
    const sourcePath = path.join(repoPath, "docs", "upload.md");
    await fs.writeFile(sourcePath, "# Upload design\n\nChunk upload sessions support resumable upload and SHA256 validation.\n", "utf8");
    const store = createStore();

    const first = await store.ingest(["docs"], { tags: ["Backend", "backend"] });
    const unchanged = await store.ingest(["docs"], { tags: ["backend"] });
    await fs.writeFile(sourcePath, "# Upload design\n\nChunk upload sessions use row locks and idempotent overwrite.\n", "utf8");
    const updated = await store.ingest(["docs"], { tags: ["backend"] });

    expect(first).toMatchObject({ indexedFiles: 1, unchangedFiles: 0, indexedChunks: 1 });
    expect(unchanged).toMatchObject({ indexedFiles: 0, unchangedFiles: 1, indexedChunks: 0 });
    expect(updated).toMatchObject({ indexedFiles: 1, replacedChunks: 1, totalChunks: 1 });
    expect((await store.search("row lock upload", { minScore: 0.1 })).context).toContain("row locks");
    expect((await store.stats()).tags).toEqual({ backend: 1 });
  });

  it("returns grounded citations and supports source and tag filters", async () => {
    await fs.writeFile(path.join(repoPath, "docs", "upload.md"), "# Upload\n\nThe upload flow validates every chunk before merge.\n", "utf8");
    await fs.writeFile(path.join(repoPath, "docs", "review.md"), "# Review\n\nThe review workflow verifies reviewer ownership.\n", "utf8");
    const store = createStore();
    await store.ingest(["docs/upload.md"], { tags: ["storage"] });
    await store.ingest(["docs/review.md"], { tags: ["workflow"] });

    const response = await store.search("upload chunks", { source: "docs", tags: ["storage"], minScore: 0.1 });
    expect(response.found).toBe(true);
    expect(response.results).toHaveLength(1);
    expect(response.citations[0]).toMatch(/^docs\/upload\.md#L1-L3$/);
    expect(response.context).toContain(response.citations[0]);
    expect(response.results[0]?.chunk).not.toHaveProperty("vector");
    expect(response.results[0]?.chunk).not.toHaveProperty("keywords");
    expect((await store.search("upload", { tags: ["missing"], minScore: 0.1 })).reason).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("refuses empty, ungrounded, empty-index, and provider-mismatched queries", async () => {
    const store = createStore();
    expect((await store.search("upload")).reason).toBe("EMPTY_INDEX");
    await fs.writeFile(path.join(repoPath, "docs", "upload.md"), "# Upload\n\nUpload chunks are merged after validation.\n", "utf8");
    await store.ingest(["docs"]);

    expect((await store.search("   ")).reason).toBe("EMPTY_QUERY");
    expect((await store.search("astronomy", { minScore: 0.1 })).reason).toBe("INSUFFICIENT_EVIDENCE");
    const mismatched = new RagStore({ repoPath, embeddingProvider: new TestEmbeddingProvider("test-embedding-v2") });
    expect((await mismatched.search("upload")).reason).toBe("EMBEDDING_PROVIDER_MISMATCH");
  });

  it("requires lexical evidence when the offline hash embedding collides", async () => {
    const collisionProvider: EmbeddingProvider = { id: "local-hash-v2", embed: async () => [1] };
    await fs.writeFile(path.join(repoPath, "docs", "upload.md"), "# Upload\n\nUpload chunks are merged after validation.\n", "utf8");
    const store = new RagStore({ repoPath, embeddingProvider: collisionProvider });
    await store.ingest(["docs"]);
    expect((await store.search("astronomy", { minScore: 0.1 })).reason).toBe("INSUFFICIENT_EVIDENCE");
    expect((await store.search("unrelated astronomy equipment system", { minScore: 0.1 })).reason).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("rejects paths outside the repository and skips unsupported files", async () => {
    await fs.writeFile(path.join(repoPath, "docs", "image.png"), "not an image", "utf8");
    const loader = new RagDocumentLoader({ repoPath });
    const loaded = await loader.load(["docs"]);
    expect(loaded.skipped).toEqual([{ path: "docs/image.png", reason: "UNSUPPORTED_TYPE" }]);
    await expect(loader.load([path.dirname(repoPath)])).rejects.toThrow(/outside repository/i);
  });

  it("evaluates answerability, hit rate, recall, and reciprocal rank", async () => {
    await fs.writeFile(path.join(repoPath, "docs", "upload.md"), "# Upload\n\nUpload chunks can resume after interruption.\n", "utf8");
    const store = createStore();
    await store.ingest(["docs"]);

    const result = await evaluateRag(store, [
      { id: "answerable", query: "resume upload chunks", relevantSources: ["docs/upload.md"] },
      { id: "unanswerable", query: "astronomy", expectNoAnswer: true },
    ]);
    expect(result).toMatchObject({ total: 2, passed: 2, answerabilityAccuracy: 1, hitRate: 1, meanRecallAtK: 1, meanReciprocalRank: 1 });
  });

  it("registers knowledge_search as a safe read-only tool", () => {
    const manifest = createDefaultToolRegistry().listManifest().find((tool) => tool.name === "knowledge_search");
    expect(manifest).toMatchObject({
      permissionLevel: "SAFE",
      category: "search",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
  });

  it("executes knowledge_search through the tool registry", async () => {
    await fs.writeFile(path.join(repoPath, "docs", "rag.md"), "# RAG evaluation\n\nRAG evaluation reports hit rate and recall metrics.\n", "utf8");
    await new RagStore({ repoPath, embeddingProvider: new LocalHashEmbeddingProvider() }).ingest(["docs"]);
    const result = await createDefaultToolRegistry().execute("knowledge_search", { query: "RAG evaluation recall" }, { repoPath });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ found: true, citations: ["docs/rag.md#L1-L3"] });
  });
});

function createStore(): RagStore {
  return new RagStore({ repoPath, embeddingProvider: new TestEmbeddingProvider() });
}
