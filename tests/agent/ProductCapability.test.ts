import { describe, expect, it } from "vitest";
import {
  detectResponseCapabilityDenials,
  renderProductCapabilityAnswer,
} from "../../src/agent/ProductCapability.js";
import {
  formatCapabilityRegistryForPrompt,
  getProductCapability,
  listProductCapabilities,
} from "../../src/agent/CapabilityRegistry.js";
import { enforceCapabilityTruth } from "../../src/agent/CapabilityTruthGuard.js";
import { createTestTaskFrame } from "../helpers/TaskFrameContract.js";

describe("product capability architecture", () => {
  it("renders a TaskFrame-selected capability from the registry", () => {
    const answer = renderProductCapabilityAnswer({
      topic: "REPOSITORY_WRITE",
      act: "AVAILABILITY",
    }, { locale: "zh" });
    const capability = getProductCapability("REPOSITORY_WRITE");

    expect(answer).toContain(capability.zh.name);
    expect(answer).toContain(capability.actions[0]!);
    expect(answer).toContain(capability.effects[0]!);
  });

  it("keeps the registry usable as authoritative prompt context", () => {
    expect(listProductCapabilities().length).toBeGreaterThanOrEqual(7);
    expect(formatCapabilityRegistryForPrompt()).toContain("supported=true");
    expect(formatCapabilityRegistryForPrompt()).toContain("WEB_RESEARCH");
    expect(formatCapabilityRegistryForPrompt()).toContain("actions=APPLY_PATCH");
    expect(formatCapabilityRegistryForPrompt()).not.toContain("tools=run_command");
    expect(formatCapabilityRegistryForPrompt()).toContain("MULTI_AGENT_COLLABORATION");
  });

  it("corrects false subagent capability denials", () => {
    const bad = "目前我没有 subagent 的能力，也不能委托子代理。";
    expect(detectResponseCapabilityDenials(bad)).toContain("MULTI_AGENT_COLLABORATION");
    const correction = enforceCapabilityTruth({
      taskFrame: createTestTaskFrame({
        objective: "Explain the product's collaboration capability.",
        target: "PRODUCT",
      }),
      userGoal: "我们有subagent能力吗？",
      answer: bad,
    });
    expect(correction.corrected).toBe(true);
    expect(correction.text).toContain("多 Agent 协作");
  });

  it("detects and corrects a model answer that contradicts the registry", () => {
    const bad = "我不能联网，也无法访问网页。";
    expect(detectResponseCapabilityDenials(bad)).toContain("WEB_RESEARCH");

    const correction = enforceCapabilityTruth({
      taskFrame: createTestTaskFrame({
        objective: "Explain the product's Web capability.",
        target: "PRODUCT",
      }),
      userGoal: "所以这个助手以后也没法碰外网了吗？",
      answer: bad,
    });
    expect(correction.corrected).toBe(true);
    expect(correction.text).toContain("支持受控联网研究");
    expect(correction.text).toContain("web_search");
  });

  it("does not rescan raw wording when TaskFrame says the request is not about the product", () => {
    const correction = enforceCapabilityTruth({
      taskFrame: createTestTaskFrame({
        objective: "Summarize a quoted sentence.",
        target: "DERIVATION",
      }),
      userGoal: "引用内容是：我不能联网，也无法访问网页。",
      answer: "我不能联网，也无法访问网页。",
    });

    expect(correction.corrected).toBe(false);
    expect(correction.conflicts).toContain("WEB_RESEARCH");
  });

  it("does not treat an explicit correction as another denial", () => {
    const answer = "我之前说不能联网是错的；实际上支持联网，可使用 web_search。";
    expect(detectResponseCapabilityDenials(answer)).toEqual([]);
  });
});
