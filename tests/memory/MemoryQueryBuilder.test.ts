import { describe, expect, it } from "vitest";
import { buildMemoryQuery } from "../../src/memory/MemoryQueryBuilder.js";

describe("buildMemoryQuery", () => {
  it("normalizes a semantic query and extracts generic entities", () => {
    const query = buildMemoryQuery({
      query: "把刚才 MedianFinder 写进去",
      sessionId: "session-a",
    });

    expect(query.entities).toContain("MedianFinder");
    expect(query.expandedQuery).toContain("medianfinder");
    expect(query.sameSessionBias).toBe(1);
    expect(query.evidenceBudget).toBe(5);
  });

  it("does not inject a local task mode into arbitrary queries", () => {
    const query = buildMemoryQuery({ query: "今天中国股市收盘大盘指数涨跌情况" });

    expect(query.expandedQuery).not.toContain("AGENT_LOOP");
    expect(query.expandedQuery).not.toContain("WEB_ANSWER");
  });

  it("uses recent memory as secondary query terms", () => {
    const query = buildMemoryQuery({
      query: "怎么运行",
      recentMemory: "上一轮创建了 demo_app.html 贪吃蛇小游戏",
    });

    expect(query.keywords).toEqual(expect.arrayContaining(["demo_app", "贪吃蛇小游戏"]));
  });

  it("clamps caller-selected evidence budgets", () => {
    expect(buildMemoryQuery({ query: "parser", evidenceBudget: 99 }).evidenceBudget).toBe(10);
  });
});
