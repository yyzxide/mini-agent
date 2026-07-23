import { describe, expect, it } from "vitest";
import {
  classifyExternalFactPolicy,
  requiresExternalFactVerification,
  type ExternalFactPolicy,
} from "../../src/agent/ExternalFactPolicy.js";

describe("ExternalFactPolicy", () => {
  it.each<[string, ExternalFactPolicy]>([
    ["列出巴黎所有米其林三星餐厅及其地址。", "VERIFICATION_REQUIRED"],
    ["土星现在有多少颗已确认卫星？", "VERIFICATION_REQUIRED"],
    ["《百年孤独》首次出版于哪一年？", "VERIFICATION_REQUIRED"],
    ["核实“这家公司由三位工程师创立”是否属实，并给出来源。", "VERIFICATION_REQUIRED"],
    ["Which actors appeared in every season of The Crown?", "VERIFICATION_REQUIRED"],
    ["Where was Ada Lovelace born?", "VERIFICATION_REQUIRED"],
    ["Python 3.14 的 pathlib.Path 有哪些公开方法？", "VERIFICATION_REQUIRED"],
    ["这个事件不是发生在第二阶段吗？", "VERIFICATION_REQUIRED"],
    ["这个系列第一章有哪些登场人物？", "VERIFICATION_REQUIRED"],
  ])("requires verification for precise external claims: %s", (input, expected) => {
    const result = classifyExternalFactPolicy(input);

    expect(result.policy).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(requiresExternalFactVerification(input)).toBe(true);
  });

  it.each<[string, ExternalFactPolicy]>([
    ["什么是光合作用？", "GENERAL_KNOWLEDGE"],
    ["解释哈希表的工作原理。", "GENERAL_KNOWLEDGE"],
    ["你知道《百年孤独》吗？", "GENERAL_KNOWLEDGE"],
    ["Give me an overview of plate tectonics.", "GENERAL_KNOWLEDGE"],
    ["Why is the sky blue?", "GENERAL_KNOWLEDGE"],
    ["比较 TCP 和 UDP 的基本区别。", "GENERAL_KNOWLEDGE"],
    ["Kanye West 有哪些知名的歌曲？", "GENERAL_KNOWLEDGE"],
  ])("allows broad, non-exhaustive explanations to use general knowledge: %s", (input, expected) => {
    const result = classifyExternalFactPolicy(input);

    expect(result.policy).toBe(expected);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(requiresExternalFactVerification(input)).toBe(false);
  });

  it.each<[string, ExternalFactPolicy]>([
    ["", "NOT_EXTERNAL_FACT"],
    ["早上好", "NOT_EXTERNAL_FACT"],
    ["修改 src/agent/TaskRouter.ts 中的路由逻辑。", "NOT_EXTERNAL_FACT"],
    ["帮我实现一个快速排序函数。", "NOT_EXTERNAL_FACT"],
    ["计算 17 * 23。", "NOT_EXTERNAL_FACT"],
    ["写一首关于夏天的短诗。", "NOT_EXTERNAL_FACT"],
    ["你能联网吗？", "NOT_EXTERNAL_FACT"],
    ["你刚才是不是说过“会自动保存”？", "NOT_EXTERNAL_FACT"],
    ["现在呢", "NOT_EXTERNAL_FACT"],
    ["在哪里", "NOT_EXTERNAL_FACT"],
    ["怎么打开", "NOT_EXTERNAL_FACT"],
    ["verify the current behavior", "NOT_EXTERNAL_FACT"],
  ])("does not misclassify local, derivable, creative, or transcript tasks: %s", (input, expected) => {
    expect(classifyExternalFactPolicy(input).policy).toBe(expected);
    expect(requiresExternalFactVerification(input)).toBe(false);
  });

  it("requires factual verification when a transcript reference also challenges truth", () => {
    const result = classifyExternalFactPolicy("你刚才说这座桥建于 1888 年，这是真的吗？");

    expect(result.policy).toBe("VERIFICATION_REQUIRED");
    expect(result.signals).toContain("explicit-verification");
  });

  it("exposes compositional signals instead of subject-specific rules", () => {
    const exhaustive = classifyExternalFactPolicy("请给出该系列全部作品的完整名单。");
    const volatile = classifyExternalFactPolicy("这项赛事当前比分是多少？");

    expect(exhaustive.signals).toEqual(expect.arrayContaining(["exhaustive-or-enumerated"]));
    expect(volatile.signals).toEqual(expect.arrayContaining(["volatile-fact", "precise-attribute"]));
  });
});
