import { describe, expect, it } from "vitest";
import { renderChangesCard, renderDiffViewerFrame } from "../../src/diff/TerminalDiffViewer.js";
import type { TaskDiffArtifact } from "../../src/diff/TaskDiffTypes.js";

describe("TerminalDiffViewer", () => {
  it("renders a compact interactive changes card without inline diff content", () => {
    const card = renderChangesCard(artifact(), false, true);

    expect(card).toContain("[changes] 1 file · +1 -1");
    expect(card).toContain("M src/demo.ts");
    expect(card).toContain("[ View changes ]");
    expect(card).not.toContain("oldValue");
    expect(card).not.toContain("newValue");
  });

  it("renders a non-interactive command fallback", () => {
    const card = renderChangesCard(artifact(), false, false);

    expect(card).toContain("mini-agent diff --session session-1");
    expect(card).not.toContain("[ View changes ]");
  });

  it("renders the selected file inside the terminal diff screen", () => {
    const frame = renderDiffViewerFrame(artifact(), {
      columns: 100,
      rows: 20,
      color: false,
    });

    expect(frame).toContain("Changes · 1 file · +1 -1");
    expect(frame).toContain("Files");
    expect(frame).toContain("src/demo.ts");
    expect(frame).toContain("-export const oldValue = 1;");
    expect(frame).toContain("+export const newValue = 2;");
    expect(frame).toContain("q/Esc back");
  });
});

function artifact(): TaskDiffArtifact {
  const diff = [
    "diff --git a/src/demo.ts b/src/demo.ts",
    "--- a/src/demo.ts",
    "+++ b/src/demo.ts",
    "@@ -1 +1 @@",
    "-export const oldValue = 1;",
    "+export const newValue = 2;",
  ].join("\n");
  return {
    version: 1,
    artifactId: "artifact-1",
    sessionId: "session-1",
    createdAt: "2026-07-22T00:00:00.000Z",
    beforeTree: "before",
    afterTree: "after",
    fileCount: 1,
    additions: 1,
    deletions: 1,
    files: [{
      path: "src/demo.ts",
      changeType: "MODIFIED",
      additions: 1,
      deletions: 1,
      binary: false,
    }],
    unifiedDiff: diff,
    truncated: false,
  };
}
