import { describe, expect, it } from "vitest";
import { buildSessionMemory } from "../../src/session/SessionMemory.js";
import type { JsonObject, SessionRecord, SessionRecordType } from "../../src/session/SessionTypes.js";

describe("SessionMemory", () => {
  it("keeps earlier conversation turns when tool results are noisy", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "我们之前聊了世界杯比分" }),
      record("2", "ASSISTANT_MESSAGE", { content: "我们讨论了世界杯小组赛和几场比分。" }),
      ...Array.from({ length: 40 }, (_, index) => record(`tool-${index}`, "TOOL_RESULT", {
        toolName: "read_file",
        result: {
          success: true,
          data: {
            text: "x".repeat(200),
          },
        },
      })),
      record("3", "USER_MESSAGE", { content: "我想了解当前项目的 web search" }),
      record("4", "ASSISTANT_MESSAGE", { content: "当前 web search 使用 DuckDuckGo HTML 结果解析。" }),
    ];

    const memory = buildSessionMemory(records, { maxRecords: 18, maxChars: 8_000 });

    expect(memory).toContain("[user] 我们之前聊了世界杯比分");
    expect(memory).toContain("[assistant] 我们讨论了世界杯小组赛和几场比分。");
    expect(memory).toContain("[user] 我想了解当前项目的 web search");
    expect(memory).toContain("[assistant] 当前 web search 使用 DuckDuckGo HTML 结果解析。");
  });

  it("still includes a bounded number of recent tool results", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "查一下项目" }),
      ...Array.from({ length: 20 }, (_, index) => record(`tool-${index}`, "TOOL_RESULT", {
        toolName: `tool_${index}`,
        result: { success: true },
      })),
    ];

    const memory = buildSessionMemory(records, { maxRecords: 18, maxAuxiliaryRecords: 3, maxChars: 8_000 });

    expect(memory).toContain("[user] 查一下项目");
    expect(memory).toContain("tool_17");
    expect(memory).toContain("tool_18");
    expect(memory).toContain("tool_19");
    expect(memory).not.toContain("tool_16");
  });

  it("drops a task summary that duplicates the preceding assistant answer", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "你好" }),
      record("2", "ASSISTANT_MESSAGE", { content: "你好，有什么我可以帮你的？" }),
      record("3", "TASK_SUMMARY", { summary: "你好，有什么我可以帮你的？" }),
      record("4", "USER_MESSAGE", { content: "我们继续" }),
    ];

    const memory = buildSessionMemory(records, { maxRecords: 18, maxChars: 8_000 });

    expect(memory.match(/你好，有什么我可以帮你的？/g)).toHaveLength(1);
    expect(memory).not.toContain("[summary]");
  });

  it("drops legacy assistant messages generated from agent decisions", () => {
    const records: SessionRecord[] = [
      record("1", "USER_MESSAGE", { content: "创建五子棋" }),
      record("2", "AGENT_DECISION", { type: "TOOL_CALL", toolName: "write_file" }),
      record("3", "ASSISTANT_MESSAGE", { content: "Calling tool write_file" }),
      record("4", "TASK_SUMMARY", { summary: "五子棋已创建。", success: true }),
    ];

    const memory = buildSessionMemory(records);

    expect(memory).not.toContain("Calling tool write_file");
    expect(memory).toContain("[summary] 五子棋已创建。");
  });
});

function record(id: string, type: SessionRecordType, payload: JsonObject): SessionRecord {
  return {
    id,
    sessionId: "session",
    type,
    timestamp: "2026-06-30T00:00:00.000Z",
    payload,
  };
}
