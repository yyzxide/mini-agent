import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PatchManager } from "../../src/patch/PatchManager.js";

const execFileAsync = promisify(execFile);

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-patch-manager-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "demo.txt"), "hello\n", "utf8");
  await fs.writeFile(path.join(repoPath, "delete.txt"), "bye\n", "utf8");
  await execFileAsync("git", ["add", "demo.txt", "delete.txt"], { cwd: repoPath });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("PatchManager", () => {
  it("previews a single-file modification patch", async () => {
    const manager = new PatchManager({ repoPath });

    const preview = await manager.previewPatch({ patch: modifyDemoPatch() });

    expect(preview.files).toEqual([
      { path: "demo.txt", changeType: "MODIFIED", additions: 1, deletions: 0 },
    ]);
    expect(preview.summary).toContain("demo.txt (+1, -0)");
  });

  it("previews a multi-file patch", async () => {
    const manager = new PatchManager({ repoPath });

    const preview = await manager.previewPatch({ patch: `${modifyDemoPatch()}\n${addFilePatch()}` });

    expect(preview.files).toHaveLength(2);
    expect(preview.files.map((file) => file.path)).toEqual(["demo.txt", "new.txt"]);
  });

  it("detects added files", async () => {
    const manager = new PatchManager({ repoPath });

    const preview = await manager.previewPatch({ patch: addFilePatch() });

    expect(preview.files[0]).toEqual({ path: "new.txt", changeType: "ADDED", additions: 1, deletions: 0 });
  });

  it("detects deleted files", async () => {
    const manager = new PatchManager({ repoPath });

    const preview = await manager.previewPatch({ patch: deleteFilePatch() });

    expect(preview.files[0]).toEqual({ path: "delete.txt", changeType: "DELETED", additions: 0, deletions: 1 });
  });

  it("validates a legal patch", async () => {
    const manager = new PatchManager({ repoPath });

    const result = await manager.validatePatch({ patch: modifyDemoPatch() });

    expect(result.success).toBe(true);
  });

  it("rejects an illegal patch during validation", async () => {
    const manager = new PatchManager({ repoPath });

    const result = await manager.validatePatch({ patch: modifyMissingPatch() });

    expect(result.success).toBe(false);
    expect(result.stderr ?? result.error).toContain("missing.txt");
  });

  it("applies a legal patch", async () => {
    const manager = new PatchManager({ repoPath });

    const result = await manager.applyPatch({ patch: modifyDemoPatch() });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("hello\nworld\n");
  });

  it("normalizes model-style hunk counts before applying a new file patch", async () => {
    const manager = new PatchManager({ repoPath });

    const result = await manager.applyPatch({ patch: modelStyleTwoSumPatch() });

    expect(result.success).toBe(true);
    expect(result.changedFiles).toEqual([
      { path: "two_sum.cpp", changeType: "ADDED", additions: 13, deletions: 0 },
    ]);
    await expect(fs.readFile(path.join(repoPath, "two_sum.cpp"), "utf8")).resolves.toContain("int twoSum(int a, int b)");
  });

  it("repairs model patches that omit the trailing newline at end of diff", async () => {
    const manager = new PatchManager({ repoPath });

    const result = await manager.applyPatch({ patch: modelStyle2048PatchWithoutTrailingNewline() });

    expect(result.success).toBe(true);
    expect(result.changedFiles).toEqual([
      { path: "game_2048.html", changeType: "ADDED", additions: 7, deletions: 0 },
    ]);
    await expect(fs.readFile(path.join(repoPath, "game_2048.html"), "utf8")).resolves.toContain("<title>2048</title>");
  });

  it("returns git diff after applying a patch", async () => {
    const manager = new PatchManager({ repoPath });

    await manager.applyPatch({ patch: modifyDemoPatch() });
    const diff = await manager.getDiff();

    expect(diff.diff).toContain("+world");
  });

  it("rejects empty patches", async () => {
    const manager = new PatchManager({ repoPath });

    await expect(manager.previewPatch({ patch: "   " })).rejects.toMatchObject({ code: "EMPTY_PATCH" });
  });

  it("rejects oversized patches", async () => {
    const manager = new PatchManager({ repoPath, maxPatchChars: 10 });

    await expect(manager.previewPatch({ patch: modifyDemoPatch() })).rejects.toMatchObject({ code: "PATCH_TOO_LARGE" });
  });

  it("rejects patches touching .git", async () => {
    const manager = new PatchManager({ repoPath });

    await expect(manager.previewPatch({ patch: internalPatch(".git/config") })).rejects.toMatchObject({
      code: "PATCH_TOUCHES_INTERNAL_DIRECTORY",
    });
  });

  it("rejects patches touching .mini-agent", async () => {
    const manager = new PatchManager({ repoPath });

    await expect(manager.previewPatch({ patch: internalPatch(".mini-agent/config.json") })).rejects.toMatchObject({
      code: "PATCH_TOUCHES_INTERNAL_DIRECTORY",
    });
  });
});

export function modifyDemoPatch(): string {
  return [
    "diff --git a/demo.txt b/demo.txt",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1,2 @@",
    " hello",
    "+world",
    "",
  ].join("\n");
}

export function addFilePatch(): string {
  return [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+new",
    "",
  ].join("\n");
}

export function deleteFilePatch(): string {
  return [
    "diff --git a/delete.txt b/delete.txt",
    "deleted file mode 100644",
    "--- a/delete.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");
}

function modelStyleTwoSumPatch(): string {
  return [
    "--- /dev/null",
    "+++ b/two_sum.cpp",
    "@@ -0,0 +1,15 @@",
    "+#include <iostream>",
    "+",
    "+int twoSum(int a, int b) {",
    "+    return a + b;",
    "+}",
    "+",
    "+int main() {",
    "+    int x, y;",
    "+    std::cout << \"Enter two numbers: \";",
    "+    std::cin >> x >> y;",
    "+    std::cout << \"Sum: \" << twoSum(x, y) << std::endl;",
    "+    return 0;",
    "+}",
    "",
  ].join("\n");
}

function modelStyle2048PatchWithoutTrailingNewline(): string {
  return [
    "diff --git a/game_2048.html b/game_2048.html",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/game_2048.html",
    "@@ -0,0 +1,20 @@",
    "+<!DOCTYPE html>",
    "+<html>",
    "+<head>",
    "+  <title>2048</title>",
    "+</head>",
    "+<body>play</body>",
    "+</html>",
  ].join("\n");
}

function modifyMissingPatch(): string {
  return [
    "diff --git a/missing.txt b/missing.txt",
    "--- a/missing.txt",
    "+++ b/missing.txt",
    "@@ -1 +1,2 @@",
    " missing",
    "+line",
    "",
  ].join("\n");
}

function internalPatch(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1,2 @@",
    " value",
    "+new",
    "",
  ].join("\n");
}
