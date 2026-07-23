import { describe, expect, it } from "vitest";
import { buildSessionMemory, buildSessionMemoryWithTrace } from "../../src/session/SessionMemory.js";
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

  it("preserves the newest user decision when a long session is compacted", () => {
    const records: SessionRecord[] = [
      record("old-user", "USER_MESSAGE", { content: `早期背景 ${"x".repeat(1_200)}` }),
      record("old-answer", "ASSISTANT_MESSAGE", { content: `旧回答 ${"y".repeat(1_200)}` }),
      record("latest-user", "USER_MESSAGE", { content: "最新决定：保持公开 API 不变" }),
      record("latest-answer", "ASSISTANT_MESSAGE", { content: "收到，将保留公开 API。" }),
    ];

    const memory = buildSessionMemory(records, { maxRecords: 10, maxChars: 600 });

    expect(memory).toContain("[structured session compaction v2]");
    expect(memory).toContain("最新决定：保持公开 API 不变");
    expect(memory).toContain("收到，将保留公开 API");
    expect(memory).toContain("source:latest-");
  });

  it("reports measured compaction telemetry", () => {
    const records: SessionRecord[] = [
      record("old", "USER_MESSAGE", { content: `历史内容 ${"x".repeat(2_000)}` }),
      record("latest", "ASSISTANT_MESSAGE", { content: "保留最近结论" }),
    ];

    const result = buildSessionMemoryWithTrace(records, { maxChars: 300 });

    expect(result.trace).toMatchObject({
      totalRecords: 2,
      selectedRecords: 2,
      compacted: true,
      strategy: "structured-salience-v2",
      candidateRecords: 2,
      droppedRecords: 0,
    });
    expect(result.trace.inputChars).toBeGreaterThan(result.trace.outputChars);
    expect(result.trace.estimatedInputTokens).toBeGreaterThan(result.trace.estimatedOutputTokens);
    expect(result.memory).toContain("[structured session compaction v2]");
    expect(result.trace.selections).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "latest", bucket: "CONVERSATION" }),
    ]));
  });

  it("clips oversized tool payloads and preserves auditable source reasons", () => {
    const records: SessionRecord[] = [
      record("constraint", "USER_MESSAGE", { content: "必须保持公开 API 不变" }),
      record("tool-large", "TOOL_RESULT", {
        toolName: "read_file",
        result: { content: "x".repeat(8_000) },
      }),
      record("summary", "TASK_SUMMARY", { summary: "目标文件已经定位" }),
      record("latest", "USER_MESSAGE", { content: "继续处理" }),
    ];

    const result = buildSessionMemoryWithTrace(records, { maxChars: 700, maxTokens: 175 });

    expect(result.memory).toContain("必须保持公开 API 不变");
    expect(result.memory).toContain("目标文件已经定位");
    expect(result.memory).toContain("source:constrai");
    expect(result.trace).toMatchObject({
      strategy: "structured-salience-v2",
      pinnedRecords: 2,
    });
    expect(result.trace.clippedRecords).toBeGreaterThan(0);
    expect(result.trace.selections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "constrai",
        bucket: "PINNED",
        reason: "explicit user constraint",
      }),
    ]));
  });

  it("compacts when the token budget is exceeded even if the character budget fits", () => {
    const records: SessionRecord[] = [
      record("background", "ASSISTANT_MESSAGE", { content: "历史背景".repeat(120) }),
      record("constraint", "USER_MESSAGE", { content: "必须继续保留当前公开接口" }),
    ];

    const result = buildSessionMemoryWithTrace(records, { maxChars: 2_000, maxTokens: 120 });

    expect(result.trace.inputChars).toBeLessThan(2_000);
    expect(result.trace.compacted).toBe(true);
    expect(result.trace.estimatedOutputTokens).toBeLessThanOrEqual(120);
    expect(result.memory).toContain("必须继续保留当前公开接口");
  });

  it("treats user preferences as pinned constraints during compaction", () => {
    const records: SessionRecord[] = [
      record("preference", "USER_MESSAGE", { content: "我更倾向于保留从 A 到 B 的演进记录" }),
      record("noise", "ASSISTANT_MESSAGE", { content: "x".repeat(2_000) }),
    ];

    const result = buildSessionMemoryWithTrace(records, { maxChars: 360, maxTokens: 90 });

    expect(result.memory).toContain("我更倾向于保留从 A 到 B 的演进记录");
    expect(result.trace.selections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "preferen",
        bucket: "PINNED",
        reason: "explicit user constraint",
      }),
    ]));
  });

  it("excludes records produced by the active run because AgentState already carries them", () => {
    const records: SessionRecord[] = [
      record("prior-user", "USER_MESSAGE", { content: "上一轮问题" }),
      record("prior-answer", "ASSISTANT_MESSAGE", { content: "上一轮回答" }),
      record("current-user", "USER_MESSAGE", { content: "当前问题", runId: "run-current" }),
      record("current-error", "ERROR", { message: "当前 guardrail 错误" }),
      record("current-tool", "TOOL_RESULT", { toolName: "web_search", result: { success: true } }),
    ];

    const result = buildSessionMemoryWithTrace(records, { excludeRunId: "run-current" });

    expect(result.memory).toContain("上一轮问题");
    expect(result.memory).toContain("上一轮回答");
    expect(result.memory).not.toContain("当前问题");
    expect(result.memory).not.toContain("当前 guardrail 错误");
    expect(result.memory).not.toContain("web_search");
    expect(result.trace).toMatchObject({ totalRecords: 2, excludedCurrentRunRecords: 3 });
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
