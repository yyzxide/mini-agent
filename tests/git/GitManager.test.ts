import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitManager } from "../../src/git/GitManager.js";

const execFileAsync = promisify(execFile);
let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-git-manager-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "staged.txt"), "before\n", "utf8");
  await fs.writeFile(path.join(repoPath, "unstaged.txt"), "before\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: repoPath });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("GitManager", () => {
  it("summarizes staged, unstaged, and untracked files without changing the real index", async () => {
    await fs.writeFile(path.join(repoPath, "staged.txt"), "after\nadded\n", "utf8");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "unstaged.txt"), "after\n", "utf8");
    await fs.writeFile(path.join(repoPath, "untracked.txt"), "one\ntwo\n", "utf8");
    const statusBefore = await execFileAsync("git", ["status", "--short"], { cwd: repoPath });
    const objectsBefore = await execFileAsync("git", ["count-objects", "-v"], { cwd: repoPath });

    const manager = new GitManager({ repoPath });
    const files = await manager.getChangedFiles();
    const summary = await manager.generateDiffSummary();
    const statusAfter = await execFileAsync("git", ["status", "--short"], { cwd: repoPath });
    const objectsAfter = await execFileAsync("git", ["count-objects", "-v"], { cwd: repoPath });

    expect(files).toEqual(["staged.txt", "unstaged.txt", "untracked.txt"]);
    expect(summary).toMatchObject({
      changedFiles: files,
      fileCount: 3,
      additions: 5,
      deletions: 2,
    });
    expect(summary.stat).toContain("3 files changed");
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
    expect(objectsAfter.stdout).toBe(objectsBefore.stdout);
  });
});
