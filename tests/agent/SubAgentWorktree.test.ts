import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubAgentWorktree, fingerprintWorkingTree } from "../../src/agent/SubAgentWorktree.js";
import { PatchManager } from "../../src/patch/PatchManager.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-worktree-test-"));
  await execa("git", ["init", "--quiet"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "committed\n", "utf8");
  await execa("git", ["add", "tracked.txt"], { cwd: repoPath });
  await execa("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "--quiet", "-m", "initial",
  ], { cwd: repoPath });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("SubAgentWorktree", () => {
  it("copies the current dirty baseline without modifying the parent", async () => {
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "parent dirty\n", "utf8");
    await fs.writeFile(path.join(repoPath, "untracked.txt"), "untracked context\n", "utf8");
    const before = await fingerprintWorkingTree(repoPath);
    const worktree = await SubAgentWorktree.create({ repoPath });
    const childPath = worktree.snapshot.repoPath;

    expect(worktree.snapshot.kind).toBe("GIT_WORKTREE");
    expect(worktree.snapshot.baselineFingerprint).toBe(before);
    await expect(fs.readFile(path.join(childPath, "tracked.txt"), "utf8")).resolves.toBe("parent dirty\n");
    await expect(fs.readFile(path.join(childPath, "untracked.txt"), "utf8")).resolves.toBe("untracked context\n");

    const applied = await new PatchManager({ repoPath: childPath }).applyPatch({
      patch: [
        "diff --git a/tracked.txt b/tracked.txt",
        "--- a/tracked.txt",
        "+++ b/tracked.txt",
        "@@ -1 +1 @@",
        "-parent dirty",
        "+child change",
        "",
      ].join("\n"),
    });
    expect(applied.success).toBe(true);
    expect(await worktree.createPatch()).toContain("+child change");
    await expect(fs.readFile(path.join(repoPath, "tracked.txt"), "utf8")).resolves.toBe("parent dirty\n");

    await worktree.dispose();
    await expect(fs.access(childPath)).rejects.toBeDefined();
  });

  it("detects a parent-side conflict after the child baseline", async () => {
    const worktree = await SubAgentWorktree.create({ repoPath });
    const applied = await new PatchManager({ repoPath: worktree.snapshot.repoPath }).applyPatch({
      patch: [
        "diff --git a/tracked.txt b/tracked.txt",
        "--- a/tracked.txt",
        "+++ b/tracked.txt",
        "@@ -1 +1 @@",
        "-committed",
        "+child",
        "",
      ].join("\n"),
    });
    expect(applied.success).toBe(true);
    const childPatch = await worktree.createPatch();

    await fs.writeFile(path.join(repoPath, "tracked.txt"), "parent concurrent change\n", "utf8");
    expect(await fingerprintWorkingTree(repoPath)).not.toBe(worktree.snapshot.baselineFingerprint);
    await expect(new PatchManager({ repoPath }).validatePatch({ patch: childPatch }))
      .resolves.toMatchObject({ success: false });

    await worktree.dispose();
  });
});
