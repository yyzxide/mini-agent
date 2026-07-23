import { describe, expect, it } from "vitest";
import {
  inspectPriorResponseConsistency,
  renderPriorResponseSafeFallback,
} from "../../src/agent/PriorResponseTruthGuard.js";
import type { ConversationMessage } from "../../src/session/ConversationHistory.js";

describe("PriorResponseTruthGuard", () => {
  const conversation: ConversationMessage[] = [
    { role: "user", content: "第三章有什么能力？" },
    { role: "assistant", content: "击败守门者以后会获得星核变身。" },
    { role: "user", content: "钥匙在哪里？" },
    { role: "assistant", content: "钥匙在下一章获得。" },
  ];

  it("detects a denial that conflicts with a relevant visible assistant output", () => {
    const violation = inspectPriorResponseConsistency(
      "这个作品哪来的星核变身？以及你说的各种变身",
      "我之前没有说过会获得星核变身，我只是说可以击败守门者。",
      conversation,
    );

    expect(violation).toMatchObject({
      code: "PRIOR_RESPONSE_DENIAL",
    });
    expect(violation?.excerpt).toContain("星核变身");
    expect(violation?.matchedTerms).toContain("星核变身");
  });

  it("detects rewriting the intent of a visible literal claim", () => {
    expect(inspectPriorResponseConsistency(
      "这个作品哪来的星核变身？以及你说的各种变身",
      "所以之前我说“击败守门者获得星核变身”，指的是打这个角色，不是让玩家获得变身能力。",
      conversation,
    )).toMatchObject({
      code: "PRIOR_RESPONSE_DENIAL",
    });
  });

  it("allows an answer that acknowledges and retracts the visible output", () => {
    expect(inspectPriorResponseConsistency(
      "你刚才说星核变身，这个说法是不是错了？",
      "我确实说过“会获得星核变身”，但这条说法没有证据，我撤回它。",
      conversation,
    )).toBeUndefined();
  });

  it("does not force an admission when complete history contains no matching claim", () => {
    expect(inspectPriorResponseConsistency(
      "你是不是说过会自动删除存档？",
      "我没有说过会自动删除存档。",
      conversation,
      { historyTruncated: false },
    )).toBeUndefined();
  });

  it("rejects a definitive denial when the selected history is known to be incomplete", () => {
    expect(inspectPriorResponseConsistency(
      "你是不是说过会自动删除存档？",
      "我没有说过会自动删除存档。",
      conversation,
      { historyTruncated: true },
    )).toMatchObject({
      code: "INSUFFICIENT_HISTORY_FOR_DENIAL",
    });
  });

  it("renders a fallback that separates transcript evidence from external truth", () => {
    const violation = inspectPriorResponseConsistency(
      "你之前说星核变身，这个说法哪来的？",
      "我之前并未说过星核变身。",
      conversation,
    );
    expect(violation).toBeDefined();

    const fallback = renderPriorResponseSafeFallback(violation!, "zh");
    expect(fallback).toContain("确实存在我此前输出的相关原文");
    expect(fallback).toContain("不能证明其中的外部事实正确");
    expect(fallback).toContain("撤回未核验部分");
  });
});
