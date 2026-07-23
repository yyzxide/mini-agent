import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  looksLikeArtifactFollowUp,
  resolveArtifactFollowUp,
} from "../../src/agent/ArtifactFollowUp.js";
import type { SessionRecord } from "../../src/session/SessionTypes.js";

function makeRecord(
  type: SessionRecord["type"],
  payload: SessionRecord["payload"],
  id = `${type}-1`,
): SessionRecord {
  return {
    id,
    sessionId: "session-1",
    type,
    timestamp: "2026-07-22T00:00:00.000Z",
    payload,
  };
}

describe("ArtifactFollowUp", () => {
  it("answers a bare location follow-up from the latest turn FILE_CHANGE", () => {
    const repoPath = path.resolve("/workspace/mini-agent");
    const records: SessionRecord[] = [
      makeRecord("USER_MESSAGE", { content: "写一个贪吃蛇游戏的代码文件" }),
      makeRecord("FILE_CHANGE", {
        files: [{ path: "demo_app.html", changeType: "ADDED", additions: 169, deletions: 0 }],
      }),
      makeRecord("TASK_SUMMARY", { summary: "已创建 demo_app.html", success: true }),
    ];

    const resolution = resolveArtifactFollowUp(repoPath, "在哪里", records);

    expect(resolution).toEqual(expect.objectContaining({
      intent: "LOCATION",
      source: "FILE_CHANGE",
    }));
    expect(resolution?.files).toEqual([expect.objectContaining({
      relativePath: "demo_app.html",
      absolutePath: path.join(repoPath, "demo_app.html"),
      changeType: "ADDED",
    })]);
    expect(resolution?.answer).toContain(path.join(repoPath, "demo_app.html"));
  });

  it("only uses file changes produced after the immediately preceding user turn", () => {
    const repoPath = path.resolve("/workspace/mini-agent");
    const records: SessionRecord[] = [
      makeRecord("USER_MESSAGE", { content: "创建旧文件" }, "user-old"),
      makeRecord("FILE_CHANGE", {
        files: [{ path: "old.ts", changeType: "ADDED" }],
      }, "change-old"),
      makeRecord("USER_MESSAGE", { content: "创建新文件" }, "user-new"),
      makeRecord("FILE_CHANGE", {
        files: [{ path: "src/new.ts", changeType: "MODIFIED" }],
      }, "change-new"),
    ];

    const resolution = resolveArtifactFollowUp(repoPath, "改的是哪个文件？", records);

    expect(resolution?.files.map((file) => file.relativePath)).toEqual(["src/new.ts"]);
    expect(resolution?.answer).not.toContain("old.ts");
  });

  it("lists multiple artifacts and retains their change types", () => {
    const repoPath = path.resolve("/workspace/mini-agent");
    const records: SessionRecord[] = [
      makeRecord("USER_MESSAGE", { content: "创建页面" }),
      makeRecord("FILE_CHANGE", {
        files: [
          { path: "index.html", changeType: "ADDED" },
          { path: "src/game.ts", changeType: "MODIFIED" },
        ],
      }),
    ];

    const resolution = resolveArtifactFollowUp(repoPath, "哪些文件？", records);

    expect(resolution?.intent).toBe("LIST");
    expect(resolution?.answer).toContain("2 个文件变更");
    expect(resolution?.answer).toContain("（新增）");
    expect(resolution?.answer).toContain("（修改）");
  });

  it("does not confuse explicit agent or unrelated location questions with artifacts", () => {
    expect(looksLikeArtifactFollowUp("你在哪里？")).toBe(false);
    expect(looksLikeArtifactFollowUp("北京在哪里？")).toBe(false);
    expect(looksLikeArtifactFollowUp("在哪里？")).toBe(true);
    expect(looksLikeArtifactFollowUp("刚才那个文件呢？")).toBe(true);
  });

  it("does not fall back to an older turn or accept paths outside the repository", () => {
    const repoPath = path.resolve("/workspace/mini-agent");
    const noLatestArtifact: SessionRecord[] = [
      makeRecord("FILE_CHANGE", { files: [{ path: "old.ts", changeType: "ADDED" }] }),
      makeRecord("USER_MESSAGE", { content: "解释一下结果" }),
      makeRecord("TASK_SUMMARY", { summary: "解释完成", success: true }),
    ];
    expect(resolveArtifactFollowUp(repoPath, "在哪里", noLatestArtifact)).toBeUndefined();

    const escapedArtifact: SessionRecord[] = [
      makeRecord("USER_MESSAGE", { content: "创建文件" }),
      makeRecord("FILE_CHANGE", { files: [{ path: "../outside.txt", changeType: "ADDED" }] }),
    ];
    expect(resolveArtifactFollowUp(repoPath, "在哪里", escapedArtifact)).toBeUndefined();
  });
});
