import { describe, expect, it } from "vitest";
import {
  buildConversationHistory,
  buildConversationHistoryWithTrace,
  focusConversationHistory,
} from "../../src/session/ConversationHistory.js";
import type { JsonObject, SessionRecord, SessionRecordType } from "../../src/session/SessionTypes.js";

describe("ConversationHistory", () => {
  it("turns agent summaries into assistant messages and removes direct-answer duplicates", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "讨论 Skill" }),
      record("2", "ASSISTANT_MESSAGE", { content: "Skill 很容易创建。" }),
      record("3", "TASK_SUMMARY", { summary: "Skill 很容易创建。", success: true, mode: "DIRECT_ANSWER" }),
      record("4", "USER_MESSAGE", { content: "写个五子棋小游戏吧" }),
      record("5", "TASK_SUMMARY", { summary: "五子棋已创建为 gobang.html。", success: true, mode: "AGENT_LOOP" }),
    ];

    expect(buildConversationHistory(records)).toEqual([
      { role: "user", content: "讨论 Skill" },
      { role: "assistant", content: "Skill 很容易创建。" },
      { role: "user", content: "写个五子棋小游戏吧" },
      { role: "assistant", content: "五子棋已创建为 gobang.html。" },
    ]);
  });

  it("keeps the newest complete conversation within its budget", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "旧问题" }),
      record("2", "ASSISTANT_MESSAGE", { content: "旧回答" }),
      record("3", "USER_MESSAGE", { content: "最近问题" }),
      record("4", "ASSISTANT_MESSAGE", { content: "最近回答" }),
    ];

    expect(buildConversationHistory(records, { maxMessages: 2, maxChars: 100 })).toEqual([
      { role: "user", content: "最近问题" },
      { role: "assistant", content: "最近回答" },
    ]);
    expect(buildConversationHistory(records, { maxMessages: 2, maxChars: 0 })).toEqual([]);

    const result = buildConversationHistoryWithTrace(records, { maxMessages: 2, maxChars: 100 });
    expect(result.trace).toMatchObject({
      totalMessages: 4,
      selectedMessages: 2,
      truncated: true,
    });
    expect(result.trace.estimatedInputTokens).toBeGreaterThan(result.trace.estimatedOutputTokens);
  });

  it("excludes persisted agent decisions from conversational history", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "写个五子棋小游戏吧" }),
      record("2", "AGENT_DECISION", { type: "TOOL_CALL", toolName: "write_file" }),
      record("3", "ASSISTANT_MESSAGE", { content: "Calling tool write_file" }),
      record("4", "AGENT_DECISION", { type: "FINAL", summary: "五子棋已创建。" }),
      record("5", "ASSISTANT_MESSAGE", { content: "五子棋已创建。" }),
      record("6", "TASK_SUMMARY", { summary: "五子棋已创建。", success: true, mode: "AGENT_LOOP" }),
    ];

    expect(buildConversationHistory(records)).toEqual([
      { role: "user", content: "写个五子棋小游戏吧" },
      { role: "assistant", content: "五子棋已创建。" },
    ]);
  });

  it("isolates the latest exchange for an implicit demonstrative", () => {
    const messages = [
      { role: "user" as const, content: "测试 Skill" },
      { role: "assistant" as const, content: "Skill 测试完成。" },
      { role: "user" as const, content: "写个五子棋小游戏吧" },
      { role: "assistant" as const, content: "五子棋已创建。" },
    ];

    expect(focusConversationHistory(messages, "你觉得这个有难度吗")).toEqual({
      messages: [
        { role: "user", content: "写个五子棋小游戏吧" },
        { role: "assistant", content: "五子棋已创建。" },
      ],
      focusedOnLatestTurn: true,
      strategy: "LATEST_REFERENT",
      matchedAssistantMessages: 0,
    });
    expect(focusConversationHistory(messages, "之前那个 Skill 有难度吗")).toEqual({
      messages,
      focusedOnLatestTurn: false,
      strategy: "RECENT_HISTORY",
      matchedAssistantMessages: 0,
    });
  });

  it("retrieves disputed assistant claims instead of collapsing to the latest exchange", () => {
    const messages = [
      { role: "user" as const, content: "第三章有哪些特殊能力？" },
      { role: "assistant" as const, content: "击败守门者以后会获得星核变身。" },
      { role: "user" as const, content: "星核在哪里？" },
      { role: "assistant" as const, content: "星核在旧港口的箱子里。" },
      { role: "user" as const, content: "钥匙不是在下一章吗？" },
      { role: "assistant" as const, content: "对，钥匙是在下一章拿到的。" },
    ];

    const focused = focusConversationHistory(
      messages,
      "这个游戏哪来的星核变身？以及你说的各种变身",
    );

    expect(focused.strategy).toBe("PRIOR_RESPONSE_AUDIT");
    expect(focused.focusedOnLatestTurn).toBe(false);
    expect(focused.matchedAssistantMessages).toBeGreaterThan(0);
    expect(focused.messages.map((message) => message.content)).toEqual(expect.arrayContaining([
      "击败守门者以后会获得星核变身。",
      "钥匙不是在下一章吗？",
      "对，钥匙是在下一章拿到的。",
    ]));
    expect(focused.messages.length).toBeGreaterThan(2);
  });

  it("can retrieve a disputed claim beyond the old newest-16 boundary", () => {
    const messages = [
      { role: "user" as const, content: "旧问题" },
      { role: "assistant" as const, content: "旧回答声称月影协议会自动删除备份。" },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `无关消息 ${String(index)}`,
      })),
    ];

    const focused = focusConversationHistory(
      messages,
      "你之前说月影协议会自动删除备份，这个说法哪来的？",
      { maxMessages: 16, maxChars: 12_000 },
    );

    expect(focused.strategy).toBe("PRIOR_RESPONSE_AUDIT");
    expect(focused.messages.some((message) => message.content.includes("月影协议"))).toBe(true);
    expect(focused.messages.length).toBeLessThanOrEqual(16);
  });

  it("does not treat a normal reference to the assistant's proposal as an audit", () => {
    const messages = [
      { role: "user" as const, content: "给一个重构方案" },
      { role: "assistant" as const, content: "可以拆分解析器和执行器。" },
    ];

    expect(focusConversationHistory(messages, "你说的方案怎么做")).toMatchObject({
      strategy: "RECENT_HISTORY",
      matchedAssistantMessages: 0,
    });
  });
});

function record(id: string, type: SessionRecordType, payload: JsonObject): SessionRecord {
  return {
    id,
    sessionId: "session-1",
    type,
    timestamp: `2026-01-01T00:00:0${id}.000Z`,
    payload,
  };
}
