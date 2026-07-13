import { describe, expect, it } from "vitest";
import { planDirectAnswerMemory } from "../../src/memory/DirectAnswerMemoryPolicy.js";

describe("planDirectAnswerMemory", () => {
  it("does not let an ungrounded active-chat question select an older topic", () => {
    expect(planDirectAnswerMemory({
      userGoal: "你觉得这个有难度吗",
      hasRecentConversation: true,
    })).toEqual({
      retrieve: false,
      query: "你觉得这个有难度吗",
    });
  });

  it("allows explicit recall and grounded follow-ups", () => {
    expect(planDirectAnswerMemory({
      userGoal: "之前的 MedianFinder 是怎么实现的",
      hasRecentConversation: true,
    }).retrieve).toBe(true);

    expect(planDirectAnswerMemory({
      userGoal: "葡萄牙呢",
      resolvedFollowUpGoal: "葡萄牙是强队吗",
      hasRecentConversation: true,
    })).toEqual({
      retrieve: true,
      query: "葡萄牙是强队吗",
    });
  });
});
