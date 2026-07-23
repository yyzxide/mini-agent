import { describe, expect, it } from "vitest";
import {
  classifyProductMetaIntent,
  detectResponseCapabilityDenials,
  looksLikeExplicitWebAction,
  renderProductCapabilityAnswer,
} from "../../src/agent/ProductCapability.js";
import {
  formatCapabilityRegistryForPrompt,
  getProductCapability,
  listProductCapabilities,
} from "../../src/agent/CapabilityRegistry.js";
import { enforceCapabilityTruth } from "../../src/agent/CapabilityTruthGuard.js";

describe("product capability architecture", () => {
  it.each([
    ["你是不是压根碰不到互联网？", "WEB_RESEARCH", "AVAILABILITY"],
    ["所以这个助手以后也没法碰外网了吗？", "WEB_RESEARCH", "AVAILABILITY"],
    ["Can you modify repository files?", "REPOSITORY_WRITE", "AVAILABILITY"],
    ["所以你只能聊天，不能动代码？", "REPOSITORY_WRITE", "AVAILABILITY"],
    ["刚才那个权限限制是永久的吗？", "ALL", "EXPLAIN_LIMITATION"],
    ["你的能力边界是什么？", "ALL", "INVENTORY"],
    ["你都能处理哪些类型的任务？", "ALL", "INVENTORY"],
  ])("classifies compositional paraphrase %s", (input, topic, act) => {
    expect(classifyProductMetaIntent(input)).toMatchObject({
      kind: "PRODUCT_META",
      topic,
      act,
      confidence: expect.any(Number),
    });
  });

  it.each([
    "请联网查一下 Node 24 的 release notes",
    "Please search the web for Node 24 release notes",
    "网上搜一下今天的新闻",
  ])("keeps explicit web action %s out of product-meta classification", (input) => {
    expect(looksLikeExplicitWebAction(input)).toBe(true);
    expect(classifyProductMetaIntent(input)).toBeUndefined();
  });

  it("renders answers from the registry rather than a sentence-specific template", () => {
    const intent = classifyProductMetaIntent("你是否具备修改仓库文件的能力？");
    expect(intent).toBeDefined();
    const answer = renderProductCapabilityAnswer(intent!, { locale: "zh" });
    const capability = getProductCapability("REPOSITORY_WRITE");

    expect(answer).toContain(capability.zh.name);
    expect(answer).toContain(capability.tools[0]!);
    expect(answer).toContain(capability.contracts[0]!);
  });

  it("keeps the registry usable as authoritative prompt context", () => {
    expect(listProductCapabilities().length).toBeGreaterThanOrEqual(7);
    expect(formatCapabilityRegistryForPrompt()).toContain("supported=true");
    expect(formatCapabilityRegistryForPrompt()).toContain("WEB_RESEARCH");
    expect(formatCapabilityRegistryForPrompt()).toContain("apply_patch");
  });

  it("detects and corrects a model answer that contradicts the registry", () => {
    const bad = "我不能联网，也无法访问网页。";
    expect(detectResponseCapabilityDenials(bad)).toContain("WEB_RESEARCH");

    const correction = enforceCapabilityTruth("所以这个助手以后也没法碰外网了吗？", bad);
    expect(correction.corrected).toBe(true);
    expect(correction.text).toContain("支持受控联网研究");
    expect(correction.text).toContain("web_search");
  });

  it("does not treat an explicit correction as another denial", () => {
    const answer = "我之前说不能联网是错的；实际上支持联网，可使用 web_search。";
    expect(detectResponseCapabilityDenials(answer)).toEqual([]);
  });
});
