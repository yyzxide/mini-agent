import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskDiffService } from "../../src/diff/TaskDiffService.js";
import { TaskDiffStore } from "../../src/diff/TaskDiffStore.js";

const execFileAsync = promisify(execFile);
let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-task-diff-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "existing.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(repoPath, "delete.txt"), "delete me\n", "utf8");
  await execFileAsync("git", ["add", "existing.ts", "delete.txt"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("TaskDiffService", () => {
  it("captures only current-task changes including new untracked documents", async () => {
    await fs.writeFile(path.join(repoPath, "existing.ts"), "// user change\nexport const value = 1;\n", "utf8");
    const service = new TaskDiffService({ repoPath });
    const before = await service.captureWorkingTree();
    expect(before).toBeDefined();

    await fs.writeFile(
      path.join(repoPath, "existing.ts"),
      "// user change\nexport const value = 1;\nexport const agentValue = 2;\n",
      "utf8",
    );
    await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "docs", "design.md"), "# Design\n\nCreated by the task.\n", "utf8");
    const after = await service.captureWorkingTree();
    expect(after).toBeDefined();

    const artifact = await service.createArtifact("session-1", before!, after!);

    expect(artifact.files.map((file) => [file.path, file.changeType])).toEqual([
      ["docs/design.md", "ADDED"],
      ["existing.ts", "MODIFIED"],
    ]);
    expect(artifact.unifiedDiff).toContain("+Created by the task.");
    expect(artifact.unifiedDiff).toContain("+export const agentValue = 2;");
    expect(artifact.unifiedDiff).not.toContain("+// user change");
    expect(artifact.additions).toBe(4);
    expect(artifact.deletions).toBe(0);
  });

  it("persists and retrieves the latest artifact", async () => {
    const service = new TaskDiffService({ repoPath });
    const before = await service.captureWorkingTree();
    await fs.writeFile(path.join(repoPath, "new.txt"), "hello\n", "utf8");
    const after = await service.captureWorkingTree();
    const artifact = await service.createArtifact("session-1", before!, after!);
    const store = new TaskDiffStore(repoPath);

    await store.save(artifact);

    await expect(store.read("session-1", artifact.artifactId)).resolves.toEqual(artifact);
    await expect(store.latest("session-1")).resolves.toEqual(artifact);
  });

  it("reports deleted and renamed files", async () => {
    const service = new TaskDiffService({ repoPath });
    const before = await service.captureWorkingTree();
    await fs.rename(path.join(repoPath, "existing.ts"), path.join(repoPath, "renamed.ts"));
    await fs.rm(path.join(repoPath, "delete.txt"));
    const after = await service.captureWorkingTree();

    const artifact = await service.createArtifact("session-1", before!, after!);

    expect(artifact.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "delete.txt", changeType: "DELETED" }),
      expect.objectContaining({ path: "renamed.ts", oldPath: "existing.ts", changeType: "RENAMED" }),
    ]));
  });

  it("does not modify the user's real staging area while capturing a tree", async () => {
    await fs.writeFile(path.join(repoPath, "existing.ts"), "export const staged = 2;\n", "utf8");
    await execFileAsync("git", ["add", "existing.ts"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "existing.ts"), "export const unstaged = 3;\n", "utf8");
    const beforeStatus = (await execFileAsync("git", ["status", "--short"], { cwd: repoPath })).stdout;
    const beforeCached = (await execFileAsync("git", ["diff", "--cached"], { cwd: repoPath })).stdout;

    await new TaskDiffService({ repoPath }).captureWorkingTree();

    const afterStatus = (await execFileAsync("git", ["status", "--short"], { cwd: repoPath })).stdout;
    const afterCached = (await execFileAsync("git", ["diff", "--cached"], { cwd: repoPath })).stdout;
    expect(afterStatus).toBe(beforeStatus);
    expect(afterCached).toBe(beforeCached);
  });
});
