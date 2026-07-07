import { describe, expect, it } from "vitest";
import { looksLikeRepositoryAnalysisTask, routeTask } from "../../src/agent/TaskRouter.js";

describe("TaskRouter", () => {
  it("routes standalone code snippet requests to direct answer mode", () => {
    expect(routeTask("写一个两数之和的C++代码")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("帮我写个游戏代码吧，2048这个游戏")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes repository edit requests to the agent loop", () => {
    expect(routeTask("给 README 增加配置说明")).toMatchObject({
      intent: "AGENT_LOOP",
    });
  });

  it("routes repository inspection requests to the agent loop", () => {
    expect(routeTask("inspect this repository and summarize modules")).toMatchObject({
      intent: "AGENT_LOOP",
    });
  });

  it("detects repository analysis tasks without confusing them with mutation tasks", () => {
    expect(looksLikeRepositoryAnalysisTask("分析当前文件夹的项目")).toBe(true);
    expect(looksLikeRepositoryAnalysisTask("inspect this repository and summarize modules")).toBe(true);
    expect(looksLikeRepositoryAnalysisTask("给 README 增加配置说明")).toBe(false);
  });

  it("routes conversation memory questions to direct answer mode", () => {
    expect(routeTask("你还记得我们刚才聊了什么吗")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("现在呢")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes web research requests to web answer mode", () => {
    expect(routeTask("联网搜索一下 Valorant 最新赛事资料")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("look up the latest Node.js release")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("世界杯最新比分")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("日本队最近几场的成绩")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("edg在哪一年中夺冠了")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("当前世界杯最新比分")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("当前 TypeScript 最新版本是多少")).toMatchObject({
      intent: "WEB_ANSWER",
    });
  });

  it("routes file review requests to code review mode", () => {
    expect(routeTask("帮我检查 src/tools/WebSearchTool.ts 有没有 bug")).toMatchObject({
      intent: "CODE_REVIEW",
    });
    expect(routeTask("/home/sid/miniagent/mini-coding-agent/src/tools/WebSearchTool.ts")).toMatchObject({
      intent: "CODE_REVIEW",
    });
    expect(routeTask("检查我当前打开的文件代码是否存在问题")).toMatchObject({
      intent: "CODE_REVIEW",
    });
  });

  it("routes broad chatty questions to direct answer mode", () => {
    expect(routeTask("你好啊，你是谁")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("你知道洛克王国吗")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes short plain text input to direct answer mode instead of the agent loop", () => {
    expect(routeTask("clear")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("apple pear pork")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes casual no-op or cancellation messages to direct answer mode", () => {
    expect(routeTask("没事，我按错了")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("算了")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });
});
