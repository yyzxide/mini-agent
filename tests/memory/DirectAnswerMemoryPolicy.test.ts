import { describe, expect, it } from "vitest";
import { planDirectAnswerMemory } from "../../src/memory/DirectAnswerMemoryPolicy.js";

describe("planDirectAnswerMemory", () => {
  it("does not let an ungrounded active-chat question select an older topic", () => {
    expect(planDirectAnswerMemory({
      userGoal: "你觉得这个有难度吗",
      hasRecentConversation: true,
    }).retrieve).toBe(false);
  });

  it("allows explicit recall but not an ordinary grounded follow-up", () => {
    expect(planDirectAnswerMemory({
      userGoal: "之前的 MedianFinder 是怎么实现的",
      hasRecentConversation: true,
    }).retrieve).toBe(true);

    expect(planDirectAnswerMemory({
      userGoal: "葡萄牙呢",
      resolvedFollowUpGoal: "葡萄牙是强队吗",
      hasRecentConversation: true,
    }).retrieve).toBe(false);
  });

  it("never answers volatile match results from long-term memory", () => {
    expect(planDirectAnswerMemory({
      userGoal: "法国队vs西班牙队，谁赢了",
      hasRecentConversation: false,
    }).retrieve).toBe(false);
  });
});
