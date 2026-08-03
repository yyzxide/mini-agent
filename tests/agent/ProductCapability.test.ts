import { describe, expect, it } from "vitest";
import { renderProductCapabilityAnswer } from "../../src/agent/ProductCapability.js";
import {
  formatCapabilityRegistryForPrompt,
  getProductCapability,
  listProductCapabilities,
  PRODUCT_CAPABILITY_IDS,
} from "../../src/agent/CapabilityRegistry.js";
import { enforceCapabilityTruth } from "../../src/agent/CapabilityTruthGuard.js";
import { createTestTaskFrame } from "../helpers/TaskFrameContract.js";

describe("product capability architecture", () => {
  it("renders any TaskFrame-selected capability from the registry", () => {
    const answer = renderProductCapabilityAnswer({
      capabilityIds: ["MCP_TOOL_RUNTIME"],
      act: "AVAILABILITY",
    }, { locale: "zh" });
    const capability = getProductCapability("MCP_TOOL_RUNTIME");

    expect(answer).toContain(capability.zh.name);
    expect(answer).toContain(capability.actions[0]!);
    expect(answer).toContain(capability.effects[0]!);
    expect(answer).toContain("2025-11-25");
  });

  it("keeps every declared capability in the authoritative prompt inventory", () => {
    expect(listProductCapabilities()).toHaveLength(PRODUCT_CAPABILITY_IDS.length);
    expect(formatCapabilityRegistryForPrompt()).toContain("supported=true");
    for (const id of PRODUCT_CAPABILITY_IDS) {
      expect(formatCapabilityRegistryForPrompt()).toContain(id);
    }
    expect(formatCapabilityRegistryForPrompt()).toContain("actions=APPLY_PATCH");
    expect(formatCapabilityRegistryForPrompt()).not.toContain("tools=run_command");
    expect(formatCapabilityRegistryForPrompt()).toContain("surfaces=mini-agent mcp tools");
  });

  it("grounds a novel capability answer from semantic TaskFrame IDs without rescanning wording", () => {
    const arbitraryBadAnswer = "Nope — that subsystem is entirely absent.";
    const correction = enforceCapabilityTruth({
      taskFrame: createTestTaskFrame({
        objective: "Explain whether MCP tools are available.",
        target: "PRODUCT",
        productCapability: {
          act: "AVAILABILITY",
          capabilityIds: ["MCP_TOOL_RUNTIME"],
        },
      }),
      userGoal: "Does this product expose MCP tools?",
      answer: arbitraryBadAnswer,
    });

    expect(correction.corrected).toBe(true);
    expect(correction.capabilities).toEqual(["MCP_TOOL_RUNTIME"]);
    expect(correction.text).toContain("MCP external-capability runtime is supported");
    expect(correction.text).toContain("mini-agent mcp tools");
  });

  it("renders multiple selected capabilities from the same generic path", () => {
    const answer = renderProductCapabilityAnswer({
      capabilityIds: ["KNOWLEDGE_RAG", "DECLARATIVE_SKILLS", "AGENT_EVALUATION"],
      act: "AVAILABILITY",
    }, { locale: "zh" });

    expect(answer).toContain("仓库文档 RAG");
    expect(answer).toContain("声明式 Skills");
    expect(answer).toContain("AgentBench 评测");
  });

  it("uses semantic prior-response audit metadata for limitation explanations", () => {
    const correction = enforceCapabilityTruth({
      taskFrame: createTestTaskFrame({
        objective: "Audit the earlier claim about collaboration.",
        target: "MIXED",
        productCapability: {
          act: "EXPLAIN_LIMITATION",
          capabilityIds: ["MULTI_AGENT_COLLABORATION"],
        },
        conversationEvidence: {
          purpose: "PRIOR_RESPONSE_AUDIT",
          requiresHistory: true,
        },
      }),
      userGoal: "你刚才为什么说不能使用子代理？",
      answer: "任意模型草稿",
    });

    expect(correction.corrected).toBe(true);
    expect(correction.text).toContain("上一轮回答");
    expect(correction.text).toContain("多 Agent 协作");
  });

  it("does not apply a capability rendering when TaskFrame says the request is not product meta", () => {
    const correction = enforceCapabilityTruth({
      taskFrame: createTestTaskFrame({
        objective: "Summarize a quoted sentence.",
        target: "DERIVATION",
        productCapability: {
          act: "AVAILABILITY",
          capabilityIds: ["WEB_RESEARCH"],
        },
      }),
      userGoal: "引用内容是：我不能联网。",
      answer: "我不能联网。",
    });

    expect(correction.corrected).toBe(false);
    expect(correction.capabilities).toEqual([]);
  });
});
