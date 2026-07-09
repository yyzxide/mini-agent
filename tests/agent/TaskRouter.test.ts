import { describe, expect, it } from "vitest";
import { looksLikeRepositoryAnalysisTask, routeTask } from "../../src/agent/TaskRouter.js";

describe("TaskRouter", () => {
  it("routes code implementation requests to the agent loop so files can be created", () => {
    expect(routeTask("写一个两数之和的C++代码")).toMatchObject({
      intent: "AGENT_LOOP",
    });
    expect(routeTask("帮我写个游戏代码吧，2048这个游戏")).toMatchObject({
      intent: "AGENT_LOOP",
    });
    expect(routeTask("帮我写个 最长有效括号")).toMatchObject({
      intent: "AGENT_LOOP",
    });
  });

  it("routes explicit snippet requests to direct answer mode", () => {
    expect(routeTask("给我一个 C++ 代码片段，计算两数之和")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("给我一个 C++ 代码片段，计算两数之和，不要改文件")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes repository edit requests to the agent loop", () => {
    expect(routeTask("给 README 增加配置说明")).toMatchObject({
      intent: "AGENT_LOOP",
    });
    expect(routeTask("写进去")).toMatchObject({
      intent: "AGENT_LOOP",
    });
    expect(routeTask("保存一下")).toMatchObject({
      intent: "AGENT_LOOP",
    });
  });

  it("routes file-write confirmation questions to direct state answers", () => {
    expect(routeTask("你写入了嘛？")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes package-manager missing package.json errors to direct diagnostics", () => {
    expect(routeTask([
      "sid@ubuntu:~/miniagent$ npm run guess",
      "npm error code ENOENT",
      "npm error path /home/sid/miniagent/package.json",
      "npm error enoent Could not read package.json",
    ].join("\n"))).toMatchObject({
      intent: "DIRECT_ANSWER",
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
    expect(routeTask("今天中国股市已经收盘了，查看一下大盘指数的涨跌情况")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("A股三大指数今天收盘涨跌情况")).toMatchObject({
      intent: "WEB_ANSWER",
    });
  });

  it("routes questions about web capability to direct local answers", () => {
    expect(routeTask("你不能联网吗")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("你有联网能力吗？")).toMatchObject({
      intent: "DIRECT_ANSWER",
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
