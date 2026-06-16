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
});
