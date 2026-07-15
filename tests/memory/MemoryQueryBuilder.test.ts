import { describe, expect, it } from "vitest";
import { buildMemoryQuery } from "../../src/memory/MemoryQueryBuilder.js";

describe("buildMemoryQuery", () => {
  it("detects code-task intent and expands file-write queries", () => {
    const query = buildMemoryQuery({
      query: "把刚才 MedianFinder 写进去",
      sessionId: "session-a",
    });

    expect(query.intent).toBe("CODE_TASK");
    expect(query.preferredModes).toContain("AGENT_LOOP");
    expect(query.entities).toContain("MedianFinder");
    expect(query.keywords).toEqual(expect.arrayContaining(["写入", "保存", "文件"]));
    expect(query.expandedQuery).toContain("file_change");
    expect(query.sameSessionBias).toBe(1);
  });

  it("detects web research and recency-sensitive queries", () => {
    const query = buildMemoryQuery({ query: "今天中国股市收盘大盘指数涨跌情况" });

    expect(query.intent).toBe("WEB_RESEARCH");
    expect(query.preferredModes).toEqual(["WEB_ANSWER"]);
    expect(query.recencyBias).toBeGreaterThan(0.7);
  });

  it("treats recent match-result questions as volatile web research", () => {
    const query = buildMemoryQuery({ query: "法国队vs西班牙队，谁赢了" });

    expect(query.intent).toBe("WEB_RESEARCH");
    expect(query.preferredModes).toEqual(["WEB_ANSWER"]);
  });

  it("detects pasted runtime errors", () => {
    const query = buildMemoryQuery({ query: "npm error enoent Could not read package.json" });

    expect(query.intent).toBe("ERROR_DIAGNOSIS");
    expect(query.preferredModes).toEqual(expect.arrayContaining(["DIRECT_ANSWER", "AGENT_LOOP"]));
    expect(query.expandedQuery).toContain("command_result");
  });

  it("uses recent memory as secondary query terms", () => {
    const query = buildMemoryQuery({
      query: "怎么运行",
      recentMemory: "上一轮创建了 demo_app.html 贪吃蛇小游戏",
    });

    expect(query.intent).toBe("CODE_TASK");
    expect(query.keywords).toEqual(expect.arrayContaining(["demo_app", "贪吃蛇小游戏"]));
  });
});
