import { describe, expect, it } from "vitest";
import { classifySubAgentIntent } from "../../src/agent/SubAgentIntent.js";

describe("SubAgentIntent", () => {
  it("distinguishes capability questions from execution requests", () => {
    expect(classifySubAgentIntent("我们有subagent能力吗？")).toMatchObject({
      mentioned: true,
      capabilityQuestion: true,
      preference: "AUTO",
    });
    expect(classifySubAgentIntent("请用两个subagent，一个写代码，一个review")).toMatchObject({
      capabilityQuestion: false,
      preference: "REQUIRED",
      requestedAgents: 2,
      requestsChangeProposal: true,
      requestsReview: true,
    });
  });

  it("supports a natural-language opt-out", () => {
    expect(classifySubAgentIntent("这次不要使用subagent")).toMatchObject({
      preference: "DISABLED",
    });
  });
});
