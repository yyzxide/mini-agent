import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/session/SessionTypes.js";
import {
  looksLikeFileWriteConfirmation,
  looksLikeSaveToFileFollowUp,
  resolveRepositoryFollowUpTask,
} from "../../src/agent/TaskFollowUp.js";

function makeRecord(
  type: SessionRecord["type"],
  payload: SessionRecord["payload"],
): SessionRecord {
  return {
    id: `${type}-1`,
    sessionId: "session-1",
    type,
    timestamp: "2026-07-08T00:00:00.000Z",
    payload,
  };
}

describe("TaskFollowUp", () => {
  it("detects save-to-file follow-up requests", () => {
    expect(looksLikeSaveToFileFollowUp("写入一个文件里面")).toBe(true);
    expect(looksLikeSaveToFileFollowUp("写进去")).toBe(true);
    expect(looksLikeSaveToFileFollowUp("保存一下")).toBe(true);
    expect(looksLikeSaveToFileFollowUp("把刚才的代码保存到文件里")).toBe(true);
    expect(looksLikeSaveToFileFollowUp("你是谁")).toBe(false);
  });

  it("separates file-write confirmation from save-to-file requests", () => {
    expect(looksLikeFileWriteConfirmation("你写入了嘛？")).toBe(true);
    expect(looksLikeFileWriteConfirmation("保存了吗")).toBe(true);
    expect(looksLikeSaveToFileFollowUp("你写入了嘛？")).toBe(false);
  });

  it("rewrites save-to-file follow-ups with the latest assistant code block", () => {
    const records: SessionRecord[] = [
      makeRecord("USER_MESSAGE", { content: "帮我写个 最长有效括号" }),
      makeRecord("ASSISTANT_MESSAGE", {
        content: [
          "推荐用栈解法。",
          "",
          "```python",
          "def longestValidParentheses(s: str) -> int:",
          "    return 0",
          "```",
          "",
          "```python",
          "print(longestValidParentheses(\"(()\"))",
          "```",
        ].join("\n"),
      }),
    ];

    const resolved = resolveRepositoryFollowUpTask("写入一个文件里面", records);
    expect(resolved?.resolvedGoal).toContain("请把上一轮已经生成的 Python 代码真正写入仓库文件");
    expect(resolved?.resolvedGoal).toContain("上一轮原始需求：帮我写个 最长有效括号");
    expect(resolved?.resolvedGoal).toContain("def longestValidParentheses");
    expect(resolved?.resolvedGoal).toContain("优先把第一段主实现写入文件");
    expect(resolved?.detectedLanguage).toBe("Python");
  });
});
