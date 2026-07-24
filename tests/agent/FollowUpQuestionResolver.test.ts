import { describe, expect, it } from "vitest";
import {
  expandShortFollowUpQuestion,
  isShortFollowUpQuestion,
  resolveFollowUpQuestion,
} from "../../src/agent/FollowUpQuestionResolver.js";

describe("FollowUpQuestionResolver", () => {
  it("expands a short follow-up using the previous predicate", () => {
    expect(expandShortFollowUpQuestion("方案乙呢", "方案甲是稳定的吗")).toBe("方案乙是稳定的吗");
    expect(expandShortFollowUpQuestion("第二本书呢", "第一本书的作者是谁"))
      .toBe("第二本书的作者是谁");
  });

  it("leaves ambiguous predicates to the conversation-aware model instead of dropping relation words", () => {
    expect(expandShortFollowUpQuestion("另一个国家呢", "这个国家首都是什么")).toBeUndefined();
    expect(expandShortFollowUpQuestion("另一家公司呢", "这家公司最新型号是什么")).toBeUndefined();
  });

  it("preserves count and enumeration predicates in short entity follow-ups", () => {
    expect(expandShortFollowUpQuestion("360", "腾讯有多少子公司"))
      .toBe("360有多少子公司");
    expect(expandShortFollowUpQuestion("字节跳动呢", "腾讯有哪些核心产品"))
      .toBe("字节跳动有哪些核心产品");
  });

  it("resolves the previous user message from session memory", () => {
    expect(resolveFollowUpQuestion(
      "方案乙呢",
      "[user] 方案甲是稳定的吗\n[assistant] 是的。",
    )).toBe("方案乙是稳定的吗");
  });

  it("resolves from structured conversation without reparsing compressed memory text", () => {
    expect(resolveFollowUpQuestion(
      "方案乙呢",
      [
        { role: "user", content: "方案甲是稳定的吗" },
        { role: "assistant", content: "是的。" },
      ],
    )).toBe("方案乙是稳定的吗");
  });

  it("does not rewrite a short audit of the assistant's prior answer", () => {
    expect(isShortFollowUpQuestion("你说过吗")).toBe(false);
    expect(resolveFollowUpQuestion(
      "你说过吗",
      [
        { role: "user", content: "某个物品在哪里？" },
        { role: "assistant", content: "在北门。" },
      ],
    )).toBeUndefined();
  });

  it("does not classify a long standalone request as a short follow-up", () => {
    expect(isShortFollowUpQuestion("请分析当前仓库的整体架构并给出完整改造建议")).toBe(false);
  });
});
