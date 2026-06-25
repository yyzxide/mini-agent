import { describe, expect, it } from "vitest";
import { routeTask } from "../../src/agent/TaskRouter.js";

describe("TaskRouter", () => {
  it("routes standalone code snippet requests to direct answer mode", () => {
    expect(routeTask("写一个两数之和的C++代码")).toMatchObject({
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
  });

  it("routes broad chatty questions to direct answer mode", () => {
    expect(routeTask("你好啊，你是谁")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
    expect(routeTask("你知道洛克王国吗")).toMatchObject({
      intent: "DIRECT_ANSWER",
    });
  });
});
