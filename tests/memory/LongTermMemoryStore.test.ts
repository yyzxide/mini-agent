import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongTermMemoryStore, extractKeywords, formatLongTermMemoryResults, redactMemoryText } from "../../src/memory/LongTermMemoryStore.js";
import { SessionStore } from "../../src/session/SessionStore.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-memory-"));
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("LongTermMemoryStore", () => {
  it("indexes task summaries and retrieves them by related query", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "coding session" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "帮我实现数据流的中位数" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "实现 MedianFinder，使用两个堆维护数据流中位数，并导出 TypeScript 类。",
        success: true,
        mode: "AGENT_LOOP",
        finalDiff: "+++ b/src/MedianFinder.ts\n@@ -0,0 +1,10 @@",
      },
    });

    const store = new LongTermMemoryStore({ repoPath });
    const indexResult = await store.indexSession(sessionStore, session.sessionId);
    const results = await store.search("之前数据流中位数怎么做的", { limit: 3 });

    expect(indexResult.indexed).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0].entry.sessionId).toBe(session.sessionId);
    expect(results[0].entry.text).toContain("MedianFinder");
    expect(results[0].matchedKeywords.length).toBeGreaterThan(0);
  });

  it("indexes memory compaction records without duplicating existing ids", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "long session" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "MEMORY_COMPACTION",
      payload: {
        summary: "这次会话主要讨论了 Agent 长期记忆、RAG 检索和本地索引设计。",
        source: "test",
      },
    });

    const store = new LongTermMemoryStore({ repoPath });
    await store.indexSession(sessionStore, session.sessionId);
    const secondIndex = await store.indexSession(sessionStore, session.sessionId);
    const entries = await store.list(10);
    const results = await store.search("RAG 长期记忆", { limit: 5 });

    expect(secondIndex.total).toBe(1);
    expect(entries).toHaveLength(1);
    expect(results[0].entry).toMatchObject({ source: "MEMORY_COMPACTION", kind: "SESSION_SUMMARY", scope: "SESSION" });
  });

  it("formats empty and non-empty search results for context injection", async () => {
    expect(formatLongTermMemoryResults([])).toBe("(none)");

    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "format session" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "已经创建贪吃蛇小游戏 demo_app.html，并说明可用浏览器直接打开。",
        success: true,
        mode: "AGENT_LOOP",
        finalDiff: "+++ b/demo_app.html\n@@ -0,0 +1,10 @@",
      },
    });

    const store = new LongTermMemoryStore({ repoPath });
    await store.indexSession(sessionStore, session.sessionId);
    const formatted = formatLongTermMemoryResults(await store.search("贪吃蛇 怎么运行"));

    expect(formatted).toContain("source=TASK_SUMMARY");
    expect(formatted).toContain("demo_app.html");
  });

  it("extracts mixed English and Chinese keywords", () => {
    expect(extractKeywords("MedianFinder 数据流中位数 RAG memory")).toEqual(expect.arrayContaining([
      "medianfinder",
      "memory",
      "数据流中位数",
      "数据",
      "中位",
    ]));
  });

  it("supports explicit remember, stats, forget, and clear lifecycle", async () => {
    const store = new LongTermMemoryStore({ repoPath });
    const first = await store.remember({ text: "Windows 环境使用 npm test 验证", title: "Windows verification" });
    await store.remember({ text: "Linux 环境保持 LF 换行" });

    await expect(store.search("Windows npm test", { limit: 3 })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: expect.objectContaining({ id: first.id, source: "MANUAL" }) }),
    ]));
    await expect(store.stats()).resolves.toMatchObject({ total: 2, bySource: { MANUAL: 2 } });
    await expect(store.remove(first.id)).resolves.toBe(true);
    await expect(store.remove(first.id)).resolves.toBe(false);
    await expect(store.clear()).resolves.toBe(1);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("serializes concurrent writers so read-modify-write does not lose memories", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => (
      new LongTermMemoryStore({ repoPath }).remember({
        title: `concurrent topic ${index}`,
        text: `Convention number ${index}`,
      })
    )));

    await expect(new LongTermMemoryStore({ repoPath }).stats()).resolves.toMatchObject({ total: 8, active: 8 });
  });

  it("rejects malformed persisted records with an actionable index position", async () => {
    const store = new LongTermMemoryStore({ repoPath });
    await store.init();
    await fs.writeFile(path.join(repoPath, ".mini-agent", "memory", "index.jsonl"), "{\"id\":\"broken\"}\n", "utf8");

    await expect(store.list()).rejects.toThrow("Invalid memory entry at index 0");
  });

  it("does not index failed task summaries", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "failed task" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: { summary: "Incorrect failed conclusion", success: false, mode: "AGENT_LOOP" },
    });

    const store = new LongTermMemoryStore({ repoPath });
    await store.indexSession(sessionStore, session.sessionId);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("does not promote transient direct answers into long-term memory", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "casual chat" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "你觉得这个有难度吗" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "错误地回答了更早的 Skill 话题。",
        success: true,
        mode: "DIRECT_ANSWER",
      },
    });

    const store = new LongTermMemoryStore({ repoPath });
    await store.indexSession(sessionStore, session.sessionId);

    await expect(store.list()).resolves.toEqual([]);
  });

  it("redacts common secrets before persistence", async () => {
    expect(redactMemoryText("api_key=secret-value password: hunter2 sk-abcdefghijklmnop")).toBe(
      "api_key=[REDACTED] password=[REDACTED] [REDACTED_API_KEY]",
    );
    const store = new LongTermMemoryStore({ repoPath });
    const entry = await store.remember({ text: "token=very-secret-token keep this decision" });
    expect(entry.text).not.toContain("very-secret-token");
  });

  it("supersedes same-topic manual memory and excludes expired entries", async () => {
    const store = new LongTermMemoryStore({ repoPath });
    const oldEntry = await store.remember({ title: "test command", text: "Use npm test", confidence: 0.6 });
    const newEntry = await store.remember({ title: "test command", text: "Use pnpm test", confidence: 0.95 });
    await store.remember({ title: "temporary token", text: "short lived", ttlDays: 0.00000001 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = await store.list();
    const results = await store.search("test command", { minScore: 0 });
    const stats = await store.stats();
    expect(listed.find((entry) => entry.id === oldEntry.id)?.metadata.supersededBy).toBe(newEntry.id);
    expect(listed.find((entry) => entry.id === oldEntry.id)?.status).toBe("SUPERSEDED");
    expect(results.map((result) => result.entry.id)).toContain(newEntry.id);
    expect(results.map((result) => result.entry.id)).not.toContain(oldEntry.id);
    expect(stats).toMatchObject({ total: 3, active: 1, expired: 1, superseded: 1 });
  });

  it("reactivates the previous same-topic memory when the replacement is forgotten", async () => {
    const store = new LongTermMemoryStore({ repoPath });
    const oldEntry = await store.remember({ title: "package manager", text: "Use npm" });
    const replacement = await store.remember({ title: "package manager", text: "Use pnpm" });

    await expect(store.remove(replacement.id)).resolves.toBe(true);
    const restored = (await store.list()).find((entry) => entry.id === oldEntry.id);
    expect(restored).toMatchObject({ status: "ACTIVE" });
    expect(restored?.supersededBy).toBeUndefined();
  });

  it("supports a pluggable embedding provider", async () => {
    const store = new LongTermMemoryStore({
      repoPath,
      embeddingProvider: { id: "fixture-embedding", embed: async () => [1, 0, 0] },
    });
    const entry = await store.remember({ text: "provider test" });
    expect(entry.embeddingProvider).toBe("fixture-embedding");
    expect(entry.vector).toEqual([1, 0, 0]);
    await expect(store.stats()).resolves.toMatchObject({ embeddingProvider: "fixture-embedding" });
  });

  it("does not compare memories from a different embedding provider or vector dimension", async () => {
    const indexed = new LongTermMemoryStore({
      repoPath,
      embeddingProvider: { id: "provider-a", embed: async () => [1, 0] },
    });
    await indexed.remember({ title: "upload policy", text: "Uploads require checksums." });

    const differentProvider = new LongTermMemoryStore({
      repoPath,
      embeddingProvider: { id: "provider-b", embed: async () => [1, 0] },
    });
    const differentDimensions = new LongTermMemoryStore({
      repoPath,
      embeddingProvider: { id: "provider-a", embed: async () => [1] },
    });

    await expect(differentProvider.search("upload policy", { minScore: 0 })).resolves.toEqual([]);
    await expect(differentDimensions.search("upload policy", { minScore: 0 })).resolves.toEqual([]);
  });

  it("explicitly migrates schema and embeddings instead of doing so during search", async () => {
    const original = new LongTermMemoryStore({
      repoPath,
      embeddingProvider: { id: "provider-a", embed: async () => [1, 0] },
    });
    await original.remember({ title: "upload policy", text: "Uploads require checksums." });
    const migrated = new LongTermMemoryStore({
      repoPath,
      embeddingProvider: { id: "provider-b", embed: async () => [1, 0, 0] },
    });

    await expect(migrated.search("upload policy", { minScore: 0 })).resolves.toEqual([]);
    await expect(migrated.migrate()).resolves.toMatchObject({ total: 1, embeddingsMigrated: 1, embeddingProvider: "provider-b" });
    const entries = await migrated.list();
    expect(entries[0]).toMatchObject({ schemaVersion: 2, embeddingProvider: "provider-b", vector: [1, 0, 0] });
  });

  it("does not auto-promote plans, web answers, or outcomes without a diff", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "non durable records" });
    for (const payload of [
      { summary: "A successful plan", success: true, mode: "PLAN" },
      { summary: "A web fact", success: true, mode: "WEB_ANSWER" },
      { summary: "No repository evidence", success: true, mode: "AGENT_LOOP" },
    ]) {
      await sessionStore.appendRecord(session.sessionId, { type: "TASK_SUMMARY", payload });
    }

    const store = new LongTermMemoryStore({ repoPath });
    await expect(store.indexSession(sessionStore, session.sessionId)).resolves.toMatchObject({ indexed: 0 });
    await expect(store.list()).resolves.toEqual([]);
  });

  it("can exclude the active session before ranking retrieval candidates", async () => {
    const store = new LongTermMemoryStore({ repoPath });
    await store.remember({ sessionId: "active", title: "五子棋", text: "active session result" });
    const historical = await store.remember({ sessionId: "historical", title: "五子棋", text: "historical result" });

    const results = await store.search("五子棋", { excludeSessionId: "active", limit: 5, minScore: 0 });

    expect(results.map((result) => result.entry.id)).toContain(historical.id);
    expect(results.every((result) => result.entry.sessionId !== "active")).toBe(true);
  });
});
