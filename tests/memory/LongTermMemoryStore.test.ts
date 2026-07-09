import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongTermMemoryStore, extractKeywords, formatLongTermMemoryResults } from "../../src/memory/LongTermMemoryStore.js";
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
    expect(results[0].entry.source).toBe("MEMORY_COMPACTION");
  });

  it("formats empty and non-empty search results for context injection", async () => {
    expect(formatLongTermMemoryResults([])).toBe("(none)");

    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "format session" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "已经创建贪吃蛇小游戏 demo_app.html，并说明可用浏览器直接打开。",
        mode: "AGENT_LOOP",
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
});
