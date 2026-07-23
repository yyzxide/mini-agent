import { describe, expect, it } from "vitest";
import {
  expandShortFollowUpQuestion,
  isShortFollowUpQuestion,
  resolveFollowUpQuestion,
} from "../../src/agent/FollowUpQuestionResolver.js";

describe("FollowUpQuestionResolver", () => {
  it("expands a short follow-up using the previous predicate", () => {
    expect(expandShortFollowUpQuestion("葡萄牙呢", "西班牙是强队吗")).toBe("葡萄牙是强队吗");
    expect(expandShortFollowUpQuestion("阿根廷呢", "葡萄牙世界杯最新的比赛得分"))
      .toBe("阿根廷世界杯最新的比赛得分");
  });

  it("resolves the previous user message from session memory", () => {
    expect(resolveFollowUpQuestion(
      "葡萄牙呢",
      "[user] 西班牙是强队吗\n[assistant] 是的。",
    )).toBe("葡萄牙是强队吗");
  });

  it("resolves from structured conversation without reparsing compressed memory text", () => {
    expect(resolveFollowUpQuestion(
      "葡萄牙呢",
      [
        { role: "user", content: "西班牙是强队吗" },
        { role: "assistant", content: "是的。" },
      ],
    )).toBe("葡萄牙是强队吗");
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
