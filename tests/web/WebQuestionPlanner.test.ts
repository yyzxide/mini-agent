import { describe, expect, it } from "vitest";
import {
  buildFallbackWebQuestionPlan,
  expandShortFollowUpQuestion,
  planWebQuestion,
  resolveFollowUpQuestion,
} from "../../src/web/WebQuestionPlanner.js";

describe("WebQuestionPlanner", () => {
  it("carries previous scope for follow-up questions", () => {
    const plan = buildFallbackWebQuestionPlan(
      "日本队最近几场的成绩",
      "[user] 世界杯最新比分\n[assistant] 暂未核验到完整世界杯即时比分。",
    );

    expect(plan.standaloneQuestion).toContain("世界杯最新比分");
    expect(plan.standaloneQuestion).toContain("日本队最近几场的成绩");
    expect(plan.searchQueries.some((query) => query.includes("世界杯") && query.includes("日本队"))).toBe(true);
    expect(plan.answerInstructions.join("\n")).toContain("keep competitions separate");
  });

  it("expands short follow-up questions by inheriting the previous predicate", () => {
    expect(expandShortFollowUpQuestion("葡萄牙呢", "西班牙是强队吗")).toBe("葡萄牙是强队吗");
    expect(expandShortFollowUpQuestion("阿根廷呢", "葡萄牙世界杯最新的比赛得分")).toBe("阿根廷世界杯最新的比赛得分");
  });

  it("resolves short follow-up questions from session memory", () => {
    expect(resolveFollowUpQuestion(
      "葡萄牙呢",
      "[user] 西班牙是强队吗\n[assistant] 是的，西班牙是传统强队。",
    )).toBe("葡萄牙是强队吗");
  });

  it("reuses the previous question when the user confirms switching to web", () => {
    const plan = buildFallbackWebQuestionPlan(
      "嗯切换吧",
      "[user] YouTube现在最热门的视频是什么\n[assistant] 可以切换到联网模式查询。",
    );

    expect(plan.standaloneQuestion).toBe("YouTube现在最热门的视频是什么");
    expect(plan.needsLiveData).toBe(true);
  });

  it("adds source-focused queries for live sports data", () => {
    const plan = buildFallbackWebQuestionPlan("世界杯最新比分", "(none)");

    expect(plan.needsLiveData).toBe(true);
    expect(plan.searchQueries.some((query) => query.includes("site:fifa.com"))).toBe(true);
    expect(plan.sourceHints).toContain("live score source");
  });

  it("adds finance-focused queries for current stock market close data", () => {
    const plan = buildFallbackWebQuestionPlan("今天中国股市已经收盘了，查看一下大盘指数的涨跌情况", "(none)");

    expect(plan.needsLiveData).toBe(true);
    expect(plan.searchQueries.some((query) => query.includes("东方财富") || query.includes("新浪财经"))).toBe(true);
    expect(plan.searchQueries.some((query) => query.includes("上证指数") && query.includes("创业板指"))).toBe(true);
    expect(plan.sourceHints).toContain("major finance quote page");
    expect(plan.answerInstructions.join("\n")).toContain("index level");
  });

  it("does not assume one domain for ambiguous championship questions", () => {
    const plan = buildFallbackWebQuestionPlan("edg在哪一年中夺冠了", "(none)");

    expect(plan.searchQueries.some((query) => query.toLowerCase().includes("league of legends"))).toBe(true);
    expect(plan.searchQueries.some((query) => query.toLowerCase().includes("valorant"))).toBe(true);
    expect(plan.sourceHints).toContain("team honours page");
    expect(plan.answerInstructions.join("\n")).toContain("do not assume one domain");
    expect(plan.answerInstructions.join("\n")).toContain("separate championships by game");
  });

  it("uses model generated web research plans when valid", async () => {
    const plan = await planWebQuestion({
      userGoal: "最新 TypeScript 版本是什么",
      sessionMemory: "(none)",
      client: {
        completeText: async () => ({
          success: true,
          text: JSON.stringify({
            standaloneQuestion: "TypeScript 最新稳定版本是什么",
            searchQueries: ["TypeScript latest stable version official release notes"],
            answerScope: "回答 TypeScript 最新稳定版本。",
            sourceHints: ["official release notes"],
            answerInstructions: ["只使用官方发布来源。"],
            needsLiveData: true,
            confidence: "high",
          }),
        }),
      },
    });

    expect(plan.confidence).toBe("high");
    expect(plan.searchQueries[0]).toContain("TypeScript latest stable version");
    expect(plan.sourceHints).toContain("official release notes");
  });

  it("keeps fallback broad queries when the model narrows an ambiguous acronym", async () => {
    const plan = await planWebQuestion({
      userGoal: "ag在哪一年夺冠了",
      sessionMemory: "(none)",
      client: {
        completeText: async () => ({
          success: true,
          text: JSON.stringify({
            standaloneQuestion: "AG超玩会王者荣耀KPL夺冠年份",
            searchQueries: ["AG超玩会 KPL 夺冠年份"],
            answerScope: "回答 AG 超玩会 KPL 冠军年份。",
            sourceHints: ["official source"],
            answerInstructions: ["回答 KPL 冠军年份。"],
            needsLiveData: false,
            confidence: "high",
          }),
        }),
      },
    });

    expect(plan.searchQueries.some((query) => query.toLowerCase().includes("league of legends"))).toBe(true);
    expect(plan.searchQueries.some((query) => query.toLowerCase().includes("valorant"))).toBe(true);
    expect(plan.answerInstructions.join("\n")).toContain("do not assume one domain");
  });

  it("falls back when the model planner returns invalid JSON", async () => {
    const plan = await planWebQuestion({
      userGoal: "最近有什么新闻",
      sessionMemory: "(none)",
      client: {
        completeText: async () => ({
          success: true,
          text: "not json",
        }),
      },
    });

    expect(plan.confidence).toBe("low");
    expect(plan.plannerError).toContain("invalid JSON");
    expect(plan.searchQueries.length).toBeGreaterThan(0);
  });
});
