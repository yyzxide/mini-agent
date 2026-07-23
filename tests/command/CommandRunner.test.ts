import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyVerificationCommandInput } from "../../src/command/CommandClassification.js";
import { CommandRunner, isHighRiskCommandInput } from "../../src/command/CommandRunner.js";

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

    const result = await runner.run({ executable: "echo", args: ["hello"] });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("captures stdout", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('out')"] });

    expect(result.stdout).toBe("out");
  });

  it("captures stderr", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ executable: process.execPath, args: ["-e", "process.stderr.write('err')"] });

    expect(result.stderr).toBe("err");
  });

  it("streams stdout and stderr while retaining the bounded result", async () => {
    const runner = new CommandRunner({ repoPath });
    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('live-out'); process.stderr.write('live-err')"],
    }, {
      onOutput: (event) => { chunks.push(event); },
    });

    expect(result.success).toBe(true);
    expect(chunks.some((event) => event.stream === "stdout" && event.chunk.includes("live-out"))).toBe(true);
    expect(chunks.some((event) => event.stream === "stderr" && event.chunk.includes("live-err"))).toBe(true);
    expect(result.stdout).toContain("live-out");
    expect(result.stderr).toContain("live-err");
  });

  it("returns a non-zero exit code without throwing", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ executable: process.execPath, args: ["-e", "process.exit(7)"] });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  it("handles timeouts", async () => {
    const runner = new CommandRunner({ repoPath, defaultTimeoutMs: 50 });

    const result = await runner.run({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"] });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("truncates long output", async () => {
    const runner = new CommandRunner({ repoPath, maxOutputChars: 10 });

    const result = await runner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1000))"] });

    expect(result.truncated).toBe(true);
    expect(result.stdout).toHaveLength(10);
  });

  it("rejects working directories outside the repository", async () => {
    const runner = new CommandRunner({ repoPath });

    await expect(runner.run({ executable: process.execPath, args: ["-e", "process.cwd()"], cwd: ".." })).rejects.toMatchObject({
      code: "INVALID_WORKING_DIRECTORY",
    });
  });

  it("runs shell commands only when shell mode is explicit", async () => {
    const runner = new CommandRunner({ repoPath });

    const result = await runner.run({ command: "echo shell", shell: true });

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("shell");
  });

  it("identifies shell-like structured commands as high risk", () => {
    expect(isHighRiskCommandInput({ executable: "sh", args: ["-c", "echo hello"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "/bin/bash", args: ["-c", "echo hello"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "echo hello"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "powershell.exe", args: ["-Command", "Write-Host hello"] })).toBe(true);
  });

  it("identifies inline-code interpreter flags as high risk", () => {
    expect(isHighRiskCommandInput({ executable: "node", args: ["-e", "console.log('hello')"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "node", args: ["--eval=console.log('hello')"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "node", args: ["-p", "process.env"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "node", args: ["-pe", "process.env"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "python3", args: ["-c", "print('hello')"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "ruby", args: ["-e", "puts 'hello'"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "perl", args: ["-e", "print 'hello'"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "perl", args: ["-E", "say 'hello'"] })).toBe(true);
  });

  it("does not mark ordinary structured commands as high risk", () => {
    expect(isHighRiskCommandInput({ executable: "git", args: ["status", "--short"] })).toBe(false);
    expect(isHighRiskCommandInput({ executable: "pnpm", args: ["test"] })).toBe(false);
  });

  it("requires explicit approval for destructive, publishing, and outbound commands", () => {
    expect(isHighRiskCommandInput({ executable: "rm", args: ["-rf", "src"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "git", args: ["push", "origin", "main"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "npm", args: ["publish"] })).toBe(true);
    expect(isHighRiskCommandInput({ executable: "curl", args: ["https://example.com"] })).toBe(true);
  });

  it("does not treat verification-looking arguments to unrelated executables as evidence", () => {
    expect(classifyVerificationCommandInput({ executable: "echo", args: ["npm", "test"] }).level).toBe("NONE");
    expect(classifyVerificationCommandInput({ executable: "printf", args: ["pytest"] }).level).toBe("NONE");
    expect(classifyVerificationCommandInput({ executable: "npm", args: ["test"] }).level).toBe("TEST");
  });
});
