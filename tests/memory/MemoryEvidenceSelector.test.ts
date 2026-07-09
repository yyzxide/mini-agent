import { describe, expect, it } from "vitest";
import { selectMemoryEvidence } from "../../src/memory/MemoryEvidenceSelector.js";
import { buildMemoryQuery } from "../../src/memory/MemoryQueryBuilder.js";
import type { LongTermMemoryEntry, LongTermMemorySearchResult } from "../../src/memory/LongTermMemoryStore.js";

describe("selectMemoryEvidence", () => {
  it("limits over-represented sessions and keeps diverse evidence", () => {
    const query = buildMemoryQuery({ query: "之前贪吃蛇怎么运行" });
    const selected = selectMemoryEvidence([
      result("a1", "session-a", 0.9),
      result("a2", "session-a", 0.8),
      result("a3", "session-a", 0.7),
      result("b1", "session-b", 0.6),
    ], query, { limit: 3, maxPerSession: 2 });

    expect(selected.map((item) => item.entry.id)).toEqual(["a1", "a2", "b1"]);
    expect(selected[0].selectionReasons).toContain("top-evidence");
    expect(selected[2].selectionReasons).toContain("diverse-evidence");
  });
});

function result(id: string, sessionId: string, score: number): LongTermMemorySearchResult {
  return {
    entry: entry(id, sessionId),
    score,
    rawScore: score,
    rerankScore: score,
    keywordScore: score,
    vectorScore: score,
    matchedKeywords: ["贪吃蛇"],
    selectionReasons: ["keyword:贪吃蛇"],
  };
}

function entry(id: string, sessionId: string): LongTermMemoryEntry {
  return {
    id,
    sessionId,
    repoPath: "/repo",
    source: "TASK_SUMMARY",
    title: "贪吃蛇小游戏",
    text: "创建 demo_app.html，可用浏览器直接打开。",
    keywords: ["贪吃蛇", "demo_app"],
    vector: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { mode: "AGENT_LOOP" },
  };
}
