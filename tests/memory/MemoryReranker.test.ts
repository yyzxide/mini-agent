import { describe, expect, it } from "vitest";
import { buildMemoryQuery } from "../../src/memory/MemoryQueryBuilder.js";
import { rerankMemoryResults } from "../../src/memory/MemoryReranker.js";
import type { LongTermMemoryEntry, LongTermMemorySearchResult } from "../../src/memory/LongTermMemoryStore.js";

describe("rerankMemoryResults", () => {
  it("boosts memories whose mode matches the query intent", () => {
    const query = buildMemoryQuery({ query: "实现数据流中位数算法" });
    const results = rerankMemoryResults([
      result("web", "WEB_ANSWER", "2026-01-31T00:00:00.000Z"),
      result("agent", "AGENT_LOOP", "2026-01-01T00:00:00.000Z"),
    ], query, { now: new Date("2026-01-31T00:00:00.000Z") });

    expect(results[0].entry.id).toBe("agent");
    expect(results[0].selectionReasons).toContain("mode:AGENT_LOOP");
  });

  it("boosts same-session memories for follow-up queries", () => {
    const query = buildMemoryQuery({
      query: "刚才那个怎么运行",
      sessionId: "current-session",
    });
    const results = rerankMemoryResults([
      result("other", "AGENT_LOOP", "2026-01-31T00:00:00.000Z", "other-session"),
      result("same", "AGENT_LOOP", "2026-01-31T00:00:00.000Z", "current-session"),
    ], query, { now: new Date("2026-01-31T00:00:00.000Z") });

    expect(results[0].entry.id).toBe("same");
    expect(results[0].selectionReasons).toContain("same-session");
  });
});

function result(
  id: string,
  mode: string,
  updatedAt: string,
  sessionId = "session-a",
): LongTermMemorySearchResult {
  return {
    entry: entry(id, mode, updatedAt, sessionId),
    score: 0.4,
    rawScore: 0.4,
    keywordScore: 0.5,
    vectorScore: 0.35,
    matchedKeywords: ["数据流"],
  };
}

function entry(id: string, mode: string, updatedAt: string, sessionId: string): LongTermMemoryEntry {
  return {
    id,
    sessionId,
    repoPath: "/repo",
    source: "TASK_SUMMARY",
    title: "实现数据流中位数",
    text: "实现 MedianFinder，使用两个堆维护中位数。",
    keywords: ["数据流", "中位数", "medianfinder"],
    vector: [],
    createdAt: updatedAt,
    updatedAt,
    metadata: { mode },
  };
}
