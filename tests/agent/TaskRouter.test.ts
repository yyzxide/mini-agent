import { describe, expect, it } from "vitest";
import { looksLikeDocumentCreationTask } from "../../src/agent/ArtifactIntent.js";
import {
  looksLikeRepositoryAnalysisTask,
  routeTask,
  shouldPreserveAgentLoopIntent,
} from "../../src/agent/TaskRouter.js";

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

  it("routes documentation creation requests to the agent loop on the first turn", () => {
    const exactRegression = "那你帮我写一个自身的设计文档";
    expect(routeTask(exactRegression)).toMatchObject({ intent: "AGENT_LOOP" });
    expect(shouldPreserveAgentLoopIntent(exactRegression)).toBe(true);
    expect(routeTask("请撰写一份项目架构文档")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("帮我写设计文档")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("create README documentation")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("write a design document for this agent")).toMatchObject({ intent: "AGENT_LOOP" });
  });

  it("keeps documentation advice and chat-only drafts in direct answer mode", () => {
    expect(routeTask("如何写一个设计文档")).toMatchObject({ intent: "DIRECT_ANSWER" });
    expect(routeTask("how to write a design document")).toMatchObject({ intent: "DIRECT_ANSWER" });
    expect(routeTask("写一个设计文档，只在这里展示，不要修改文件")).toMatchObject({ intent: "DIRECT_ANSWER" });
  });

  it("does not confuse features named after documents with documentation artifacts", () => {
    expect(looksLikeDocumentCreationTask("创建一个报告导出功能")).toBe(false);
    expect(looksLikeDocumentCreationTask("写 README 解析器")).toBe(false);
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
    expect(routeTask("YouTube现在最热门的视频是什么")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("嗯切换吧")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("昨天法国队踢西班牙队，谁赢了")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("法国队vs西班牙队，谁赢了")).toMatchObject({
      intent: "WEB_ANSWER",
    });
    expect(routeTask("。。。我不就是问你吗，你用搜一下啊")).toMatchObject({
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

  it("separates RAG capability questions from indexed knowledge-base queries", () => {
    expect(routeTask("你有rag系统吗")).toMatchObject({ intent: "DIRECT_ANSWER" });
    expect(routeTask("这个项目支持知识库吗？")).toMatchObject({ intent: "DIRECT_ANSWER" });
    expect(routeTask("根据已索引知识库回答上传策略是什么")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("请用知识库查一下上传策略")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("可以用知识库查询上传策略吗")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("请让这个项目支持 RAG 知识库")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(shouldPreserveAgentLoopIntent("查询知识库里的上传策略")).toBe(true);
  });

  it("routes cache ownership questions to deterministic product answers", () => {
    expect(routeTask("缓存读写和命中是模型负责还是 agent 负责？"))
      .toMatchObject({ intent: "DIRECT_ANSWER" });
  });

  it("lets explicit cache implementation requests override ownership questions", () => {
    const exactRegression = [
      "命中缓存比如写入缓存/读取缓存这是模型该做的事情还是agent该做的事情，",
      "如果是agent该做的事情，我们是不是缺失这个功能，需要补齐",
    ].join("");
    expect(routeTask(exactRegression)).toMatchObject({ intent: "AGENT_LOOP" });
    expect(shouldPreserveAgentLoopIntent(exactRegression)).toBe(true);
    expect(routeTask("请补齐 Agent 的缓存读写功能")).toMatchObject({ intent: "AGENT_LOOP" });
    expect(routeTask("Should the model or Agent own the cache?")).toMatchObject({ intent: "DIRECT_ANSWER" });
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
    expect(routeTask("long time no see")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });

  it("routes test requests to the agent loop when no higher-level skill activation applies", () => {
    expect(routeTask("test")).toMatchObject({
      intent: "AGENT_LOOP",
    });
    expect(routeTask("test this project")).toMatchObject({
      intent: "AGENT_LOOP",
    });
    expect(routeTask("测试当前项目")).toMatchObject({
      intent: "AGENT_LOOP",
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
