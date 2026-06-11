import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";

const execFileAsync = promisify(execFile);

let tempRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-cli-"));
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("mini-agent CLI", () => {
  it("registers the phase 1 commands", () => {
    const commandNames = createProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(commandNames).toEqual(["command", "config", "diff", "git", "patch", "resume", "run", "session", "sessions", "tool"]);
  });

  it("uses the expected binary name", () => {
    expect(createProgram().name()).toBe("mini-agent");
  });

  it("creates a session from the CLI", async () => {
    process.chdir(tempRoot);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "CLI Session"], { from: "user" });
    });

    const parsed = JSON.parse(output) as { title: string; sessionId: string; eventCount: number };
    expect(parsed.title).toBe("CLI Session");
    expect(parsed.sessionId).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(parsed.eventCount).toBe(1);
  });

  it("lists sessions from the CLI", async () => {
    process.chdir(tempRoot);

    const createOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Listed Session"], { from: "user" });
    });
    const created = JSON.parse(createOutput) as { sessionId: string };

    const listOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["sessions"], { from: "user" });
    });

    const sessions = JSON.parse(listOutput) as Array<{ sessionId: string; title: string }>;
    expect(sessions).toContainEqual(expect.objectContaining({
      sessionId: created.sessionId,
      title: "Listed Session",
    }));
  });

  it("initializes and shows a redacted real-model config", async () => {
    process.chdir(tempRoot);

    const initOutput = await captureStdout(async () => {
      await createProgram().parseAsync([
        "config",
        "init",
        "--real",
        "--base-url",
        "https://llm.example/v1",
        "--api-key",
        "secret-key",
        "--model",
        "agent-model",
      ], { from: "user" });
    });
    const initialized = JSON.parse(initOutput) as {
      llm?: {
        mode?: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string;
      };
    };

    expect(initialized.llm).toMatchObject({
      mode: "real",
      baseUrl: "https://llm.example/v1",
      apiKey: "<redacted>",
      model: "agent-model",
    });

    const showOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["config", "show"], { from: "user" });
    });
    const shown = JSON.parse(showOutput) as { llm?: { apiKey?: string } };
    expect(shown.llm?.apiKey).toBe("<redacted>");
  });

  it("runs a command from the CLI", async () => {
    process.chdir(tempRoot);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["command", "run", "echo hello", "--yes"], { from: "user" });
    });

    const result = JSON.parse(output) as { success: boolean; stdout: string };
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("hello");
  });

  it("records command events when a session is provided", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Command Session"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    await captureStdout(async () => {
      await createProgram().parseAsync([
        "command",
        "run",
        "echo hello",
        "--session",
        session.sessionId,
        "--yes",
      ], { from: "user" });
    });

    const eventsOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "events", session.sessionId], { from: "user" });
    });
    const events = JSON.parse(eventsOutput) as Array<{ type: string }>;

    expect(events.map((event) => event.type)).toContain("COMMAND_STARTED");
    expect(events.map((event) => event.type)).toContain("COMMAND_FINISHED");
  });

  it("records TEST_FAILED and TEST_PASSED for test-like commands", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Test Events"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    await captureStdout(async () => {
      await createProgram().parseAsync([
        "command",
        "run",
        "echo ok # npm test",
        "--session",
        session.sessionId,
        "--yes",
      ], { from: "user" });
    });
    await captureStdout(async () => {
      await createProgram().parseAsync([
        "command",
        "run",
        "false # npm test",
        "--session",
        session.sessionId,
        "--yes",
      ], { from: "user" });
    });

    const eventsOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "events", session.sessionId], { from: "user" });
    });
    const events = JSON.parse(eventsOutput) as Array<{ type: string }>;

    expect(events.map((event) => event.type)).toContain("TEST_PASSED");
    expect(events.map((event) => event.type)).toContain("TEST_FAILED");
  });

  it("previews and applies patches from the CLI", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "hello\n", "utf8");
    await execFileAsync("git", ["add", "demo.txt"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "fix.patch"), modifyDemoPatch(), "utf8");

    const previewOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["patch", "preview", "fix.patch"], { from: "user" });
    });
    const preview = JSON.parse(previewOutput) as { files: Array<{ path: string }> };
    expect(preview.files[0]?.path).toBe("demo.txt");

    const applyOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["patch", "apply", "fix.patch", "--yes"], { from: "user" });
    });
    const applyResult = JSON.parse(applyOutput) as { success: boolean; data?: { applied: boolean } };
    expect(applyResult.success).toBe(true);
    expect(applyResult.data?.applied).toBe(true);

    const diffOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["diff"], { from: "user" });
    });
    expect(diffOutput).toContain("+world");
  });

  it("runs the mock agent demo flow from the CLI", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "demo file\n", "utf8");
    await execFileAsync("git", ["add", "demo.txt"], { cwd: tempRoot });

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "demo: 给 demo.txt 增加 hello from mini-agent",
        "--mock",
        "--yes",
      ], { from: "user" });
    });

    expect(output).toContain("[session]");
    expect(output).toContain("[plan]");
    expect(output).toContain("[tool] search_code");
    expect(output).toContain("[tool] read_file");
    expect(output).toContain("[patch]");
    expect(output).toContain("[command] echo test passed");
    expect(output).toContain("[summary]");
    await expect(fs.readFile(path.join(tempRoot, "demo.txt"), "utf8")).resolves.toContain("hello from mini-agent");
  });

  it("runs with OpenAICompatibleClient when --real is passed", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "demo file\n", "utf8");
    await execFileAsync("git", ["add", "demo.txt"], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      "{\"type\":\"PLAN\",\"message\":\"Inspect repository with real client\"}",
      "{\"type\":\"FINAL\",\"summary\":\"Real client flow completed\",\"success\":true}",
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? responses[0] } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "inspect repository",
          "--real",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
          "--max-steps",
          "3",
          "--yes",
        ], { from: "user" });
      });

      expect(output).toContain("[plan] Inspect repository with real client");
      expect(output).toContain("[summary] Real client flow completed");
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("runs with OpenAICompatibleClient from .mini-agent/config.json without --real", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "demo file\n", "utf8");
    await execFileAsync("git", ["add", "demo.txt"], { cwd: tempRoot });

    await captureStdout(async () => {
      await createProgram().parseAsync([
        "config",
        "init",
        "--real",
        "--base-url",
        "https://llm.example/v1",
        "--api-key",
        "config-key",
        "--model",
        "config-model",
      ], { from: "user" });
    });

    const responses = [
      "{\"type\":\"PLAN\",\"message\":\"Configured real client\"}",
      "{\"type\":\"FINAL\",\"summary\":\"Configured client completed\",\"success\":true}",
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? responses[0] } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "inspect repository from config",
        "--max-steps",
        "3",
        "--yes",
      ], { from: "user" });
    });

    expect(output).toContain("[plan] Configured real client");
    expect(output).toContain("[summary] Configured client completed");
    expect(fetchMock).toHaveBeenCalled();

    const call = fetchMock.mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as { model: string };
    expect(init?.headers).toMatchObject({ authorization: "Bearer config-key" });
    expect(body.model).toBe("config-model");
  });
});

async function captureStdout(action: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  });

  try {
    await action();
  } finally {
    spy.mockRestore();
  }

  return chunks.join("");
}

function modifyDemoPatch(): string {
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
