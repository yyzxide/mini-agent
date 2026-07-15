import { describe, expect, it } from "vitest";
import { buildConversationHistory, focusConversationHistory } from "../../src/session/ConversationHistory.js";
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

  it("focuses an implicit demonstrative on the latest completed exchange", () => {
    const messages = [
      { role: "user" as const, content: "测试 Skill" },
      { role: "assistant" as const, content: "Skill 测试完成。" },
      { role: "user" as const, content: "写个五子棋小游戏吧" },
      { role: "assistant" as const, content: "五子棋已创建。" },
    ];

    expect(focusConversationHistory(messages, "你觉得这个有难度吗")).toEqual({
      messages: messages.slice(2),
      focusedOnLatestTurn: true,
    });
    expect(focusConversationHistory(messages, "之前那个 Skill 有难度吗")).toEqual({
      messages,
      focusedOnLatestTurn: false,
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
