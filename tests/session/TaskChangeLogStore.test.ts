import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChangeLogStore } from "../../src/session/TaskChangeLogStore.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-change-log-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("TaskChangeLogStore", () => {
  it("records task change-log entries newest first", async () => {
    const store = new TaskChangeLogStore({ repoPath: tempRoot });

    await store.append({
      sessionId: "session-1",
      task: "first task",
      mode: "DIRECT_ANSWER",
      success: true,
      summary: "answered",
      beforeChangedFiles: [],
      currentChangedFiles: ["README.md"],
      diffStat: "1 file changed, 1 insertion(+)",
      tests: [],
    });
    await store.append({
      sessionId: "session-2",
      task: "second task",
      mode: "AGENT_LOOP",
      success: false,
      summary: "failed",
      beforeChangedFiles: ["README.md"],
      currentChangedFiles: ["README.md", "src/index.ts"],
      diffStat: "2 files changed",
      tests: [{ type: "TEST_FAILED", command: "npm test", exitCode: 1 }],
      error: "boom",
    });

    const entries = await store.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.task).toBe("second task");
    expect(entries[0]?.newlyChangedFiles).toEqual(["src/index.ts"]);
    expect(entries[0]?.tests[0]).toMatchObject({ type: "TEST_FAILED", command: "npm test" });
    expect(entries[1]?.task).toBe("first task");
  });
});
