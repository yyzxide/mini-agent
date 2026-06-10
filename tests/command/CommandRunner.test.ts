import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandRunner } from "../../src/command/CommandRunner.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-command-runner-"));
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("CommandRunner", () => {
  it("executes echo hello", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ command: "echo hello" });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("captures stdout", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ command: "printf out" });

    expect(result.stdout).toBe("out");
  });

  it("captures stderr", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ command: "printf err 1>&2" });

    expect(result.stderr).toBe("err");
  });

  it("returns a non-zero exit code without throwing", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ command: "exit 7" });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  it("handles timeouts", async () => {
    const runner = new CommandRunner({ repoPath, defaultTimeoutMs: 50 });

    const result = await runner.run({ command: "sleep 1" });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("truncates long output", async () => {
    const runner = new CommandRunner({ repoPath, maxOutputChars: 10 });

    const result = await runner.run({ command: "yes x | head -c 1000" });

    expect(result.truncated).toBe(true);
    expect(result.stdout).toHaveLength(10);
  });

  it("rejects working directories outside the repository", async () => {
    const runner = new CommandRunner({ repoPath });

    await expect(runner.run({ command: "pwd", cwd: ".." })).rejects.toMatchObject({
      code: "INVALID_WORKING_DIRECTORY",
    });
  });
});
