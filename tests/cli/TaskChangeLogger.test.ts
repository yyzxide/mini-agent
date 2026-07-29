import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskDiffStore } from "../../src/diff/TaskDiffStore.js";
import { appendTaskChangeLog, readGitSnapshot } from "../../src/cli/TaskChangeLogger.js";

const execFileAsync = promisify(execFile);
let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-task-change-logger-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "existing.txt"), "baseline\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: repoPath });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("TaskChangeLogger", () => {
  it("keeps repository baseline changes separate from task-level changes", async () => {
    await fs.writeFile(path.join(repoPath, "existing.txt"), "dirty before task\n", "utf8");
    const beforeSnapshot = await readGitSnapshot(repoPath);
    await fs.writeFile(path.join(repoPath, "new.txt"), "created by task\n", "utf8");
    await new TaskDiffStore(repoPath).save({
      version: 1,
      artifactId: "artifact-1",
      sessionId: "session-1",
      createdAt: new Date().toISOString(),
      beforeTree: "before",
      afterTree: "after",
      fileCount: 2,
      additions: 2,
      deletions: 1,
      files: [
        { path: "existing.txt", changeType: "MODIFIED", additions: 1, deletions: 1, binary: false },
        { path: "new.txt", changeType: "ADDED", additions: 1, deletions: 0, binary: false },
      ],
      unifiedDiff: "",
      truncated: false,
    });

    const entry = await appendTaskChangeLog(repoPath, {
      userGoal: "modify existing and create new",
      beforeSnapshot,
      result: {
        success: true,
        sessionId: "session-1",
        mode: "AGENT_LOOP",
        summary: "done",
        metadata: { diffArtifactId: "artifact-1" },
      },
    });

    expect(entry).toMatchObject({
      beforeChangedFiles: ["existing.txt"],
      currentChangedFiles: ["existing.txt", "new.txt"],
      newlyChangedFiles: ["new.txt"],
      taskChangedFiles: ["existing.txt", "new.txt"],
      diffStat: "2 files changed, 2 insertions(+), 1 deletions(-)",
    });
  });
});
