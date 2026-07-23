import { describe, expect, it } from "vitest";
import {
  looksLikeCompleteFileReadRequest,
  mergeFileReadCoverage,
} from "../../src/agent/FileReadCoverage.js";
import { AgentState } from "../../src/agent/AgentState.js";

describe("file read coverage", () => {
  it("merges paged and out-of-order ranges into complete coverage", () => {
    let coverage = mergeFileReadCoverage(undefined, read(401, 600, 600));
    coverage = mergeFileReadCoverage(coverage, read(1, 200, 600));
    coverage = mergeFileReadCoverage(coverage, read(201, 400, 600));

    expect(coverage).toMatchObject({
      path: "src/large.ts",
      totalLines: 600,
      ranges: [{ startLine: 1, endLine: 600 }],
      complete: true,
      readCalls: 3,
    });
    expect(coverage.nextStartLine).toBeUndefined();
  });

  it("reports the first unread gap instead of assuming EOF coverage", () => {
    let coverage = mergeFileReadCoverage(undefined, read(1, 200, 800));
    coverage = mergeFileReadCoverage(coverage, read(401, 600, 800));

    expect(coverage.complete).toBe(false);
    expect(coverage.nextStartLine).toBe(201);
    expect(coverage.ranges).toEqual([
      { startLine: 1, endLine: 200 },
      { startLine: 401, endLine: 600 },
    ]);
  });

  it("invalidates old ranges when the source version changes", () => {
    const oldCoverage = mergeFileReadCoverage(undefined, read(1, 300, 600, "old"));
    const current = mergeFileReadCoverage(oldCoverage, read(301, 600, 600, "new"));

    expect(current.ranges).toEqual([{ startLine: 301, endLine: 600 }]);
    expect(current.complete).toBe(false);
    expect(current.nextStartLine).toBe(1);
    expect(current.readCalls).toBe(1);
  });

  it("invalidates in-run coverage after a successful patch changes the file", () => {
    const state = new AgentState({
      sessionId: "session",
      repoPath: "/repo",
      userGoal: "完整读取并修改 src/large.ts",
    });
    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/large.ts" },
      result: { success: true, data: read(1, 600, 600) },
    });
    expect(state.getFileReadCoverage()[0]?.complete).toBe(true);

    state.addPatchResult({
      patch: [
        "diff --git a/src/large.ts b/src/large.ts",
        "--- a/src/large.ts",
        "+++ b/src/large.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      result: { success: true },
    });
    expect(state.getFileReadCoverage()).toEqual([]);
  });

  it.each([
    "完整读取 src/large.ts 后分析",
    "把这个文件从头到尾检查一遍",
    "Read the entire file and summarize it",
  ])("recognizes explicit complete-file request %s", (goal) => {
    expect(looksLikeCompleteFileReadRequest(goal)).toBe(true);
  });
});

function read(
  startLine: number,
  endLine: number,
  totalLines: number,
  sourceVersion = "same",
) {
  return {
    path: "src/large.ts",
    startLine,
    endLine,
    totalLines,
    content: "code",
    sourceVersion,
  };
}
