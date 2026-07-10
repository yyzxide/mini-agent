import fs from "node:fs/promises";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeInteractiveInput, createProgram } from "../src/cli/index.js";
import { SessionStore } from "../src/session/SessionStore.js";
import { LongTermMemoryStore } from "../src/memory/LongTermMemoryStore.js";

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

    expect(commandNames).toEqual([
      "changes",
      "command",
      "config",
      "diff",
      "doctor",
      "git",
      "logs",
      "mcp",
      "memory",
      "patch",
      "plan",
      "repo",
      "resume",
      "review",
      "run",
      "session",
      "sessions",
      "skill",
      "status",
      "tool",
    ]);
  });

  it("uses the expected binary name", () => {
    expect(createProgram().name()).toBe("mini-agent");
  });

  it("completes interactive slash commands from partial input", () => {
    const [matches, fragment] = completeInteractiveInput("/sta");
    expect(fragment).toBe("/sta");
    expect(matches).toEqual(["/status"]);
  });

  it("completes the pause slash command", () => {
    const [matches, fragment] = completeInteractiveInput("/pa");
    expect(fragment).toBe("/pa");
    expect(matches).toEqual(["/pause"]);
  });

  it("lists matching interactive slash commands for ambiguous prefixes", () => {
    const [matches, fragment] = completeInteractiveInput("/re");
    expect(fragment).toBe("/re");
    expect(matches).toEqual(["/review", "/resume", "/remember", "/repo"]);
  });

  it("returns all slash commands when only slash is typed", () => {
    const [matches, fragment] = completeInteractiveInput("/");
    expect(fragment).toBe("/");
    expect(matches).toContain("/help");
    expect(matches).toContain("/status");
    expect(matches).toContain("/repo");
    expect(matches).toContain("/plan");
    expect(matches).toContain("/execute");
    expect(matches).toContain("/skills");
  });

  it("does not complete non-command or argument input", () => {
    expect(completeInteractiveInput("hello")).toEqual([[], "hello"]);
    expect(completeInteractiveInput("/review src/cli/index.ts")).toEqual([[], "/review src/cli/index.ts"]);
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

  it("indexes and searches long-term memory from the CLI", async () => {
    process.chdir(tempRoot);
    const sessionStore = new SessionStore({ repoPath: tempRoot });
    const session = await sessionStore.createSession({ title: "memory cli session" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "本次任务实现了最长有效括号算法，导出 longestValidParentheses 函数。",
        mode: "AGENT_LOOP",
        success: true,
      },
    });

    const indexOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["memory", "index", session.sessionId], { from: "user" });
    });
    const indexResult = JSON.parse(indexOutput) as { indexedEntries: number };

    const searchOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["memory", "search", "最长有效括号"], { from: "user" });
    });
    const searchResult = JSON.parse(searchOutput) as Array<{ entry: { text: string } }>;

    expect(indexResult.indexedEntries).toBe(1);
    expect(searchResult[0].entry.text).toContain("longestValidParentheses");
  });

  it("prints MCP-style local tool descriptors from the CLI", async () => {
    process.chdir(tempRoot);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["mcp", "tools"], { from: "user" });
    });
    const descriptors = JSON.parse(output) as Array<{
      name: string;
      annotations: { readOnlyHint: boolean; openWorldHint: boolean };
      metadata: { source: string; permissionLevel: string };
    }>;

    expect(descriptors).toContainEqual(expect.objectContaining({
      name: "web_search",
      annotations: expect.objectContaining({
        readOnlyHint: true,
        openWorldHint: true,
      }),
      metadata: expect.objectContaining({
        source: "local",
        permissionLevel: "SAFE",
      }),
    }));
  });

  it("includes last user message and latest summary in session listings", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Overview Session"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "这是会话摘要里的回答。",
          },
        },
      ],
    }), { status: 200 })));

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你是谁",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const listOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["sessions"], { from: "user" });
      });
      const sessions = JSON.parse(listOutput) as Array<{
        sessionId: string;
        lastUserMessage?: string;
        latestSummary?: string;
      }>;

      expect(sessions).toContainEqual(expect.objectContaining({
        sessionId: session.sessionId,
        lastUserMessage: "你是谁",
        latestSummary: "这是会话摘要里的回答。",
      }));
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("summarizes a session through the session summary command", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Summary Session"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "我是 mini-agent。",
          },
        },
      ],
    }), { status: 200 })));

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你是谁",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(["session", "summary", session.sessionId], { from: "user" });
      });
      const summary = JSON.parse(output) as {
        sessionId: string;
        summary: string;
        persisted: boolean;
      };

      expect(summary.sessionId).toBe(session.sessionId);
      expect(summary.persisted).toBe(false);
      expect(summary.summary).toContain("[user] 你是谁");
      expect(summary.summary).toContain("[assistant] 我是 mini-agent。");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("persists session summary when requested", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Persisted Summary"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "这是可写入摘要的回答。",
          },
        },
      ],
    }), { status: 200 })));

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你是谁",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(["session", "summary", session.sessionId, "--write"], { from: "user" });
      });
      const summary = JSON.parse(output) as {
        persisted: boolean;
        latestSummary?: string;
        eventCount: number;
      };

      expect(summary.persisted).toBe(true);
      expect(summary.latestSummary).toContain("[user] 你是谁");
      expect(summary.eventCount).toBeGreaterThanOrEqual(5);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("reports session status with recorded LLM usage", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Usage Session"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "test-model",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: {
          cached_tokens: 2,
        },
        completion_tokens_details: {
          reasoning_tokens: 3,
        },
      },
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "你好，我是 mini-agent。",
          },
        },
      ],
    }), { status: 200 })));

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你是谁",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(["session", "status", session.sessionId], { from: "user" });
      });
      const status = JSON.parse(output) as {
        sessionId: string;
        lastMode?: string;
        lastUserMessage?: string;
        latestSummary?: string;
        llm: {
          configuredModel: string | null;
          calls: number;
          promptTokens: number | null;
          completionTokens: number | null;
          totalTokens: number | null;
          cachedPromptTokens: number | null;
          reasoningTokens: number | null;
          remainingContextTokens: number | null;
          usageAvailable: boolean;
        };
      };

      expect(status.sessionId).toBe(session.sessionId);
      expect(status.lastMode).toBe("DIRECT_ANSWER");
      expect(status.lastUserMessage).toBe("你是谁");
      expect(status.latestSummary).toBe("你好，我是 mini-agent。");
      expect(status.llm.configuredModel).toBe("test-model");
      expect(status.llm.calls).toBe(1);
      expect(status.llm.promptTokens).toBe(11);
      expect(status.llm.completionTokens).toBe(7);
      expect(status.llm.totalTokens).toBe(18);
      expect(status.llm.cachedPromptTokens).toBe(2);
      expect(status.llm.reasoningTokens).toBe(3);
      expect(status.llm.remainingContextTokens).toBeNull();
      expect(status.llm.usageAvailable).toBe(true);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("prints an intelligent repository status summary", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "README.md"), "# Demo\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({
      name: "demo",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
      },
    }, null, 2), "utf8");
    await execFileAsync("git", ["add", "README.md", "package.json"], { cwd: tempRoot });
    await fs.appendFile(path.join(tempRoot, "README.md"), "\nchanged\n", "utf8");

    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["status"], { from: "user" });
    });

    expect(output).toContain("Repository state:");
    expect(output).toContain("changed file");
    expect(output).toContain("package manager: npm");
    expect(output).toContain("package scripts: build, test");
    expect(output).toContain("suggested verification");
  });

  it("initializes and shows a redacted real-model config", async () => {
    process.chdir(tempRoot);

    const initOutput = await captureStdout(async () => {
      await createProgram().parseAsync([
        "config",
        "init",
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
      await createProgram().parseAsync(["command", "run", "echo hello"], { from: "user" });
    });

    const result = JSON.parse(output) as { success: boolean; stdout: string };
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("hello");
  });

  it("prints doctor diagnostics from the CLI", async () => {
    process.chdir(tempRoot);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["doctor"], { from: "user" });
    });

    const doctor = JSON.parse(output) as {
      runtime?: { node?: string };
      commands?: { git?: { ok: boolean } };
      storage?: { sessionCount: number };
    };

    expect(doctor.runtime?.node).toMatch(/^v/);
    expect(doctor.commands?.git?.ok).toBeTypeOf("boolean");
    expect(doctor.storage?.sessionCount).toBeTypeOf("number");
  });

  it("writes runtime logs for CLI command execution", async () => {
    process.chdir(tempRoot);

    await captureStdout(async () => {
      await createProgram().parseAsync(["command", "run", "echo hello"], { from: "user" });
    });

    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["logs", "--limit", "5"], { from: "user" });
    });
    const logs = JSON.parse(output) as Array<{ component: string; message: string }>;

    expect(logs.some((record) => record.component === "command" && record.message === "Command finished")).toBe(true);
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
      ], { from: "user" });
    });
    await captureStdout(async () => {
      await createProgram().parseAsync([
        "command",
        "run",
        "false # npm test",
        "--session",
        session.sessionId,
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
      await createProgram().parseAsync(["patch", "apply", "fix.patch"], { from: "user" });
    });
    const applyResult = JSON.parse(applyOutput) as { success: boolean; data?: { applied: boolean } };
    expect(applyResult.success).toBe(true);
    expect(applyResult.data?.applied).toBe(true);

    const diffOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["diff"], { from: "user" });
    });
    expect(diffOutput).toContain("+world");
  });

  it("runs an agent flow through the OpenAI-compatible client from the CLI", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "demo file\n", "utf8");
    await execFileAsync("git", ["add", "demo.txt"], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = stubDecisionResponses(scriptedDemoDecisionResponses());
    vi.stubGlobal("fetch", fetchMock);

    let output = "";
    try {
      output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "给 demo.txt 增加 hello from mini-agent",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }

    expect(output).toContain("[session]");
    expect(output).toContain("[plan]");
    expect(output).toContain("[tool] search_code");
    expect(output).toContain("[tool] read_file");
    expect(output).toContain("[patch]");
    expect(output).toContain("[command]");
    expect(output).toContain("test passed");
    expect(output).toContain("[summary]");
    expect(fetchMock).toHaveBeenCalled();
    await expect(fs.readFile(path.join(tempRoot, "demo.txt"), "utf8")).resolves.toContain("hello from mini-agent");
  });

  it("answers explicit snippet-only requests without editing the repository", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "```cpp\nint main() { return 0; }\n```",
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "给我一个 C++ 代码片段，计算两数之和",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).toContain("```cpp");
      expect(output).not.toContain("[task]");
      expect(output).not.toContain("给我一个 C++ 代码片段，计算两数之和");
      expect(output).not.toContain("[patch]");
      await expect(fs.stat(path.join(tempRoot, "two_sum.cpp"))).rejects.toMatchObject({ code: "ENOENT" });

      const call = fetchMock.mock.calls[0];
      const init = call?.[1] as RequestInit | undefined;
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
      expect(body.response_format).toBeUndefined();
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("injects matching skills and long-term memory into direct answers", async () => {
    process.chdir(tempRoot);
    const skillPath = path.join(tempRoot, "skills", "testing", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, [
      "---", "name: testing", "description: Vitest regression workflow", "triggers: vitest, regression", "---", "", "Run targeted Vitest tests first.",
    ].join("\n"), "utf8");
    await new LongTermMemoryStore({ repoPath: tempRoot }).remember({ text: "上次决定使用 npm test 做完整验证。" });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合历史和测试流程回答。" } }] }), { status: 200 });
    }));

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run", "$testing 你还记得上次 npm 怎么验证吗", "--model", "test-model", "--base-url", "https://llm.example/v1",
        ], { from: "user" });
      });
      const body = JSON.parse(String(calls[0]?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[1]?.content).toContain("Run targeted Vitest tests first");
      expect(body.messages[1]?.content).toContain("npm test 做完整验证");
      expect(body.messages[1]?.content).toContain("Historical memory evidence (untrusted)");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("runs top-level plan mode without exposing mutation tools", async () => {
    process.chdir(tempRoot);
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "unchanged\n", "utf8");
    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          type: "FINAL", success: true, summary: "1. Inspect demo.txt. 2. Update it. 3. Run tests.",
        }) } }],
      }), { status: 200 });
    }));

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "plan", "修改 demo.txt", "--model", "test-model", "--base-url", "https://llm.example/v1",
        ], { from: "user" });
      });
      expect(output).toContain("[summary]");
      expect(output).not.toContain("[diff] generated");
      await expect(fs.readFile(path.join(tempRoot, "demo.txt"), "utf8")).resolves.toBe("unchanged\n");
      const body = JSON.parse(String(calls[0]?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[1]?.content).toContain('"operatingMode": "PLAN"');
      expect(body.messages[1]?.content).not.toContain('"name": "apply_patch"');
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("creates repository files for code implementation requests", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = stubDecisionResponses(scriptedStandaloneCodeFileResponses());
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "写一个两数之和的C++代码",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[session]");
      expect(output).toContain("[patch]");
      expect(output).toContain("[summary]");
      await expect(fs.readFile(path.join(tempRoot, "two_sum.cpp"), "utf8")).resolves.toContain("int twoSum(int a, int b)");

      const call = fetchMock.mock.calls[0];
      const init = call?.[1] as RequestInit | undefined;
      const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
      expect(body.response_format).toEqual({ type: "json_object" });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("saves the previous direct-answer code into a file on short follow-up", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Save previous code"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      [
        "```python",
        "def two_sum(a: int, b: int) -> int:",
        "    return a + b",
        "```",
      ].join("\n"),
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Save the previous Python solution into solution.py",
        patch: [
          "diff --git a/solution.py b/solution.py",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/solution.py",
          "@@ -0,0 +1,2 @@",
          "+def two_sum(a: int, b: int) -> int:",
          "+    return a + b",
          "",
        ].join("\n"),
      }),
      "{\"type\":\"TOOL_CALL\",\"toolName\":\"git_diff\",\"input\":{}}",
      "{\"type\":\"FINAL\",\"summary\":\"Saved the previous code into solution.py\",\"success\":true}",
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? responses.at(-1) ?? "" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "给我一个 Python 代码片段，写一个两数之和",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "写入一个文件里面",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[patch]");
      expect(output).toContain("solution.py");
      await expect(fs.readFile(path.join(tempRoot, "solution.py"), "utf8")).resolves.toContain("def two_sum");

      const secondCall = fetchMock.mock.calls[1];
      const secondInit = secondCall?.[1] as RequestInit | undefined;
      const secondBody = JSON.parse(String(secondInit?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondBody.messages[1]?.content).toContain("请把上一轮已经生成的 Python 代码真正写入仓库文件");
      expect(secondBody.messages[1]?.content).toContain("def two_sum(a: int, b: int) -> int:");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("reads repository evidence before summarizing the current project", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.mkdir(path.join(tempRoot, "src", "cli"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "src", "agent"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "README.md"), [
      "# mini-coding-agent",
      "",
      "A local AI coding agent CLI.",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({
      name: "mini-coding-agent",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
      },
    }, null, 2), "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "cli", "index.ts"), [
      "export function createProgram() {",
      "  return \"cli\";",
      "}",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "agent", "AgentLoop.ts"), [
      "export class AgentLoop {",
      "  run() {",
      "    return \"ok\";",
      "  }",
      "}",
      "",
    ].join("\n"), "utf8");
    await execFileAsync("git", ["add", "."], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const requestBodies: Array<{
      messages?: Array<{ role?: string; content?: string }>;
    }> = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as {
          messages?: Array<{ role?: string; content?: string }>;
        });
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: "这是一个 TypeScript 项目。",
              },
            },
          ],
        }), { status: 200 });
      })
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as {
          messages?: Array<{ role?: string; content?: string }>;
        });
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  "项目定位：这是一个本地 AI Coding Agent CLI，README.md 和 package.json 都表明它围绕命令行工具组织。",
                  "关键模块：`src/cli/index.ts` 负责 CLI 入口，`src/agent/AgentLoop.ts` 承担循环执行逻辑。",
                  "运行方式：`package.json` 暴露了 build 和 test 脚本，说明它通过 TypeScript 编译并用 Vitest 测试。",
                  "当前状态：当前 git 工作区没有额外未提交改动，git diff 为空。",
                ].join("\n"),
              },
            },
          ],
        }), { status: 200 });
      });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "分析当前文件夹的项目",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] list_files");
      expect(output).toContain("[tool] read_file");
      expect(output).toContain("[tool] git_status");
      expect(output).toContain("[tool] git_diff");
      expect(output).toContain("[summary]");
      expect(output).toContain("`src/cli/index.ts`");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstPrompt = requestBodies[0]?.messages?.find((message) => message.role === "user")?.content ?? "";
      expect(firstPrompt).toContain("Repository analysis instructions:");
      expect(firstPrompt).toContain("File: README.md");
      expect(firstPrompt).toContain("File: package.json");
      expect(firstPrompt).toContain("File: src/cli/index.ts");
      expect(firstPrompt).toContain("File: src/agent/AgentLoop.ts");

      const secondPrompt = requestBodies[1]?.messages?.find((message) => message.role === "user")?.content ?? "";
      expect(secondPrompt).toContain("Previous repository analysis answer was too shallow");
      expect(secondPrompt).toContain("Mention at least 3 supporting file paths");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("renders grounded code review findings and filters unsupported ones", async () => {
    process.chdir(tempRoot);
    await fs.mkdir(path.join(tempRoot, "src", "tools"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "tools", "WebSearchTool.ts"), [
      "function decodeHtmlEntities(text: string): string {",
      "  return text.replace(/&#(\\\\d+);/g, () => \"\");",
      "}",
      "",
    ].join("\n"), "utf8");

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Found one issue in the decoder.",
                overallVerdict: "issues_found",
                findings: [
                  {
                    severity: "medium",
                    certainty: "confirmed",
                    file: "src/tools/WebSearchTool.ts",
                    line: 2,
                    title: "Decimal entities only",
                    codeQuote: "return text.replace(/&#(\\\\d+);/g, () => \"\");",
                    reasoning: "Only decimal numeric entities are decoded.",
                  },
                  {
                    severity: "high",
                    certainty: "confirmed",
                    file: "src/tools/WebSearchTool.ts",
                    line: 2,
                    title: "Hallucinated issue",
                    codeQuote: "doesNotExist();",
                    reasoning: "This quote should be filtered.",
                  },
                ],
                followUp: [],
              }),
            },
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Keep only the grounded decoder finding.",
                findings: [
                  {
                    index: 0,
                    keep: true,
                    certainty: "possible",
                    reasoning: "The code shows a decoder limitation, but the practical impact depends on whether hex entities appear in real input.",
                  },
                ],
                followUp: ["Check real DuckDuckGo HTML samples before calling this a confirmed bug."],
              }),
            },
          },
        ],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "帮我检查 src/tools/WebSearchTool.ts 有没有 bug",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] read_file");
      expect(output).toContain("[review]");
      expect(output).toContain("Decimal entities only");
      expect(output).toContain("[possible/medium]");
      expect(output).toContain("Filtered 1 unsupported finding");
      expect(output).not.toContain("Hallucinated issue");
      expect(output).not.toContain("[summary]");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const logsOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["logs", "--limit", "10"], { from: "user" });
      });
      const logs = JSON.parse(logsOutput) as Array<{ component: string; message: string; details?: Record<string, unknown> }>;
      expect(logs.some((record) => record.component === "review" && record.message === "Review verification applied")).toBe(true);

      const changesOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["changes", "--limit", "5"], { from: "user" });
      });
      const changes = JSON.parse(changesOutput) as Array<{ mode: string; metadata?: Record<string, unknown> }>;
      expect(changes[0]?.mode).toBe("CODE_REVIEW");
      expect(changes[0]?.metadata).toMatchObject({
        reviewFile: "src/tools/WebSearchTool.ts",
        findings: 1,
        rejectedFindings: 1,
        verificationApplied: true,
      });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("includes supplemental related files in the code review prompt and metadata", async () => {
    process.chdir(tempRoot);
    await fs.mkdir(path.join(tempRoot, "src", "tools"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "src", "utils"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "tools", "WebSearchTool.ts"), [
      "import { decodeHexEntity } from \"../utils/html.js\";",
      "",
      "export function decodeHtmlEntities(text: string): string {",
      "  return decodeHexEntity(text);",
      "}",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "utils", "html.ts"), [
      "export function decodeHexEntity(text: string): string {",
      "  return text.replace(/&#x([0-9a-f]+);/gi, \"$1\");",
      "}",
      "",
    ].join("\n"), "utf8");

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "No grounded bug found in the primary file.",
                overallVerdict: "no_confirmed_issues",
                findings: [],
                followUp: ["If decoding behavior matters, inspect the helper implementation path that was imported."],
              }),
            },
          },
        ],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "帮我检查 src/tools/WebSearchTool.ts 有没有 bug",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] read_file");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const firstCall = fetchMock.mock.calls[0];
      const init = firstCall?.[1] as RequestInit | undefined;
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const userMessage = body.messages?.find((message) => message.role === "user")?.content ?? "";
      expect(userMessage).toContain("Supplemental related files:");
      expect(userMessage).toContain("File: src/utils/html.ts");
      expect(userMessage).toContain("return decodeHexEntity(text);");

      const logsOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["logs", "--limit", "10"], { from: "user" });
      });
      const logs = JSON.parse(logsOutput) as Array<{ component: string; message: string; details?: Record<string, unknown> }>;
      expect(logs.some((record) => record.component === "review"
        && record.message === "Review supplemental files loaded"
        && hasStringArrayEntry(record.details?.supplementalFiles, "src/utils/html.ts"))).toBe(true);

      const changesOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["changes", "--limit", "5"], { from: "user" });
      });
      const changes = JSON.parse(changesOutput) as Array<{ metadata?: Record<string, unknown> }>;
      expect(changes[0]?.metadata).toMatchObject({
        reviewFile: "src/tools/WebSearchTool.ts",
        supplementalFileCount: 1,
      });
      expect(changes[0]?.metadata?.supplementalFiles).toEqual(["src/utils/html.ts"]);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("runs file-focused review through the dedicated review command", async () => {
    process.chdir(tempRoot);
    await fs.mkdir(path.join(tempRoot, "src", "demo"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "demo", "sample.ts"), [
      "export function sample(value: string) {",
      "  return value.trim();",
      "}",
      "",
    ].join("\n"), "utf8");

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "No grounded bug found in the primary file.",
              overallVerdict: "no_confirmed_issues",
              findings: [],
              followUp: [],
            }),
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "review",
          "src/demo/sample.ts",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[session]");
      expect(output).toContain("[review]");
      expect(output).toContain("src/demo/sample.ts");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("records task runs in the task change log", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "我是 mini-agent。",
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你是谁",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(["changes"], { from: "user" });
      });
      const changes = JSON.parse(output) as Array<{ task: string; mode: string; summary: string }>;

      expect(changes[0]).toMatchObject({
        task: "你是谁",
        mode: "DIRECT_ANSWER",
        summary: "我是 mini-agent。",
      });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("answers current web questions in web answer mode", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const answerBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        return new Response(fakeDuckDuckGoHtml(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://example.com/roco-news") {
        return new Response("<html><body><main>2026年6月19日更新，新增宠物夜回犀牛和天擎犀牛。</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      if (body.messages[0]?.content.includes("web question planner")) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  standaloneQuestion: "洛克王国最新版本是什么，最新的宠物",
                  searchQueries: ["洛克王国 最新版本 最新宠物 官方 更新公告"],
                  answerScope: "回答洛克王国当前版本和最新宠物。",
                  sourceHints: ["official source", "game update notice"],
                  answerInstructions: ["只回答资料能核验的版本和宠物。"],
                  needsLiveData: true,
                  confidence: "high",
                }),
              },
            },
          ],
        }), { status: 200 });
      }

      answerBodies.push(body);
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "根据来源，最新更新是 2026 年 6 月 19 日，新增宠物包括夜回犀牛和天擎犀牛。\n\n来源：洛克王国更新公告 https://example.com/roco-news",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "洛克王国最新版本是什么，最新的宠物",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] web_search");
      expect(output).toContain("[tool] fetch_url");
      expect(output).toContain("[answer]");
      expect(output).toContain("夜回犀牛");
      expect(output).not.toContain("[summary]");
      expect(answerBodies[0]?.messages[0]?.content).toContain("web_search and fetch_url");
      expect(answerBodies[0]?.messages[1]?.content).toContain("2026年6月19日更新");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("continues fetching later ranked sources when earlier web pages fail", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const answerBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        return new Response([
          "<html><body>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://example.com/1\">Result One</a><div class=\"result__snippet\">First source</div></div>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://example.com/2\">Result Two</a><div class=\"result__snippet\">Second source</div></div>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://example.com/3\">Result Three</a><div class=\"result__snippet\">Third source</div></div>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://example.com/4\">Result Four</a><div class=\"result__snippet\">Fourth source works</div></div>",
          "</body></html>",
        ].join(""), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://example.com/1" || urlText === "https://example.com/2" || urlText === "https://example.com/3") {
        return new Response("binary", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "image/png" },
        });
      }

      if (urlText === "https://example.com/4") {
        return new Response("<html><body><main>Fourth source confirmed the latest note.</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      if (body.messages[0]?.content.includes("web question planner")) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  standaloneQuestion: "示例产品最新说明是什么",
                  searchQueries: ["示例产品 最新 说明 官方"],
                  answerScope: "回答示例产品的最新说明。",
                  sourceHints: ["official source"],
                  answerInstructions: ["只使用已经抓取到的资料。"],
                  needsLiveData: true,
                  confidence: "high",
                }),
              },
            },
          ],
        }), { status: 200 });
      }

      answerBodies.push(body);
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "根据第四个来源，最新说明已经确认。",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "示例产品最新说明是什么",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(fetchMock.mock.calls.some((call) => String(call[0]) === "https://example.com/4")).toBe(true);
      expect(answerBodies[0]?.messages[1]?.content).toContain("fetched sources: 1");
      expect(answerBodies[0]?.messages[1]?.content).toContain("Fourth source confirmed");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("prefers official release-style sources before forum-like pages", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const pageFetches: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        return new Response([
          "<html><body>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://forum.example.com/thread-1\">TypeScript forum guess</a><div class=\"result__snippet\">Community discussion about the latest release.</div></div>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html\">TypeScript 5.9 release notes</a><div class=\"result__snippet\">Official TypeScript release notes.</div></div>",
          "</body></html>",
        ].join(""), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://forum.example.com/thread-1" || urlText === "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html") {
        pageFetches.push(urlText);
        return new Response("<html><body><main>release details</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      if (body.messages[0]?.content.includes("web question planner")) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  standaloneQuestion: "TypeScript latest release notes",
                  searchQueries: ["TypeScript latest release notes official"],
                  answerScope: "回答 TypeScript 最新 release notes。",
                  sourceHints: ["official source", "release notes"],
                  answerInstructions: ["优先使用官方 release notes。"],
                  needsLiveData: true,
                  confidence: "high",
                }),
              },
            },
          ],
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "TypeScript 最新版本以官方 release notes 为准。",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "TypeScript 最新版本是什么",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(pageFetches[0]).toBe("https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("uses previous web context to scope follow-up searches", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Web Memory"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const duckQueries: string[] = [];
    const answerContexts: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        const parsed = new URL(urlText);
        duckQueries.push(parsed.searchParams.get("q") ?? "");
        return new Response(fakeDuckDuckGoHtml(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://example.com/roco-news") {
        return new Response("<html><body><main>日本队世界杯小组赛最近成绩：日本 2-1 示例队。</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      if (body.messages[0]?.content.includes("web question planner")) {
        const isJapanFollowUp = prompt.includes("日本队最近几场的成绩");
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  standaloneQuestion: isJapanFollowUp
                    ? "世界杯范围内，日本队最近几场比赛成绩"
                    : "世界杯最新比分",
                  searchQueries: isJapanFollowUp
                    ? ["世界杯 日本队 最近几场 成绩 比分 赛果 official"]
                    : ["世界杯 最新比分 official live scores"],
                  answerScope: isJapanFollowUp
                    ? "继承上一轮世界杯范围，只回答世界杯内日本队比赛。"
                    : "回答世界杯最新比分。",
                  sourceHints: ["official competition site", "live score source"],
                  answerInstructions: [
                    "For sports results, keep competitions separate; do not mix friendlies, qualifiers, leagues, cups, or different tournaments unless the user asks for all competitions.",
                  ],
                  needsLiveData: true,
                  confidence: "high",
                }),
              },
            },
          ],
        }), { status: 200 });
      }

      answerContexts.push(prompt);
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: duckQueries.length <= 1
                ? "暂未核验到完整世界杯即时比分。"
                : "限定在世界杯范围内，日本队最近成绩是日本 2-1 示例队。",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "世界杯最新比分",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "日本队最近几场的成绩",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).toContain("世界杯范围");
      expect(duckQueries.some((query) => query.includes("世界杯") && query.includes("日本队"))).toBe(true);
      expect(answerContexts.at(-1)).toContain("[user] 世界杯最新比分");
      expect(answerContexts.at(-1)).toContain("keep competitions separate");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("keeps ambiguous esports championship questions broad", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const duckQueries: string[] = [];
    const answerContexts: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        const parsed = new URL(urlText);
        duckQueries.push(parsed.searchParams.get("q") ?? "");
        return new Response(fakeEdgDuckDuckGoHtml(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://example.com/edg-honours") {
        return new Response("<html><body><main>EDG honours: League of Legends Worlds 2021 champion; Valorant Champions 2024 champion.</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      if (body.messages[0]?.content.includes("web question planner")) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  standaloneQuestion: "EDG 夺冠年份，按不同电竞项目区分",
                  searchQueries: ["EDG honours championships League of Legends Valorant"],
                  answerScope: "EDG 未指定游戏项目，回答时按项目列出主要冠军。",
                  sourceHints: ["team honours page", "esports wiki"],
                  answerInstructions: [
                    "If the entity is a multi-game team, organization, person, product, or acronym and the user did not specify a domain, do not assume one domain. List the main verified interpretations/categories and ask the user to specify if they need a narrower answer.",
                    "For esports teams, separate championships by game/title and tournament.",
                  ],
                  needsLiveData: false,
                  confidence: "high",
                }),
              },
            },
          ],
        }), { status: 200 });
      }

      answerContexts.push(prompt);
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "EDG 没指定游戏项目，主要冠军包括：《英雄联盟》S11 全球总决赛 2021 年；《无畏契约》Valorant Champions 2024 年。",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "edg在哪一年中夺冠了",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).toContain("英雄联盟");
      expect(output).toContain("无畏契约");
      expect(duckQueries.some((query) => query.toLowerCase().includes("league of legends"))).toBe(true);
      expect(duckQueries.some((query) => query.toLowerCase().includes("valorant"))).toBe(true);
      expect(answerContexts.at(-1)).toContain("do not assume one domain");
      expect(answerContexts.at(-1)).toContain("separate championships by game");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("passes previous session messages into follow-up direct answers", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Memory Session"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      "我们刚才聊了 session 记忆。",
      "我记得，上一轮我们聊了 session 记忆。",
    ];
    const calls: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: responses.shift() ?? "fallback",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "第一轮：我们聊了 session 记忆",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "现在呢",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("我记得");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const secondBody = JSON.parse(String(calls[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondBody.messages[1]?.content).toContain("Context:");
      expect(secondBody.messages[1]?.content).toContain("[user] 第一轮：我们聊了 session 记忆");
      expect(secondBody.messages[1]?.content).toContain("[assistant] 我们刚才聊了 session 记忆。");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("inherits direct-answer mode for short follow-up questions and resolves omitted predicates", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Short Follow-up"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const calls: RequestInit[] = [];
    const responses = [
      "是的，西班牙是传统强队。",
      "是的，葡萄牙也是传统强队。",
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: responses.shift() ?? "fallback",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "西班牙是强队吗",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "葡萄牙呢",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).toContain("葡萄牙也是传统强队");
      expect(output).not.toContain("[tool] web_search");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const secondBody = JSON.parse(String(calls[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondBody.messages[1]?.content).toContain("葡萄牙是强队吗");
      expect(secondBody.messages[1]?.content).toContain("Resolved follow-up question: 葡萄牙是强队吗");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("does not override explicit web-answer intent for short follow-up questions", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Short Follow-up Web"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        return new Response(fakeDuckDuckGoHtml(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://example.com/roco-news") {
        return new Response("<html><body><main>最新官方版本说明。</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      if (body.messages[0]?.content.includes("web question planner")) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  standaloneQuestion: "最新的呢",
                  searchQueries: ["最新的呢 官方 更新说明"],
                  answerScope: "回答最新信息。",
                  sourceHints: ["official source"],
                  answerInstructions: ["只回答已核验的最新信息。"],
                  needsLiveData: true,
                  confidence: "high",
                }),
              },
            },
          ],
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "这是联网回答。",
            },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你是谁",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "最新的呢",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] web_search");
      expect(output).toContain("[answer]");
      expect(output).toContain("这是联网回答");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("replies naturally to accidental no-op messages without calling the model", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "没事，我按错了",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).toContain("好的，没事，你继续说就行。");
      expect(output).not.toContain("用户误触");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("runs with OpenAICompatibleClient by default", async () => {
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
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
          "--max-steps",
          "3",
        ], { from: "user" });
      });

      expect(output).toContain("[plan] Inspect repository with real client");
      expect(output).toContain("[summary] Real client flow completed");
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("runs with OpenAICompatibleClient from mini-agent.config.json", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo.txt"), "demo file\n", "utf8");
    await execFileAsync("git", ["add", "demo.txt"], { cwd: tempRoot });

    await captureStdout(async () => {
      await createProgram().parseAsync([
        "config",
        "init",
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

function scriptedDemoDecisionResponses(): string[] {
  return [
    "{\"type\":\"PLAN\",\"message\":\"Inspect demo.txt and prepare a patch\"}",
    "{\"type\":\"TOOL_CALL\",\"toolName\":\"search_code\",\"input\":{\"query\":\"demo\",\"path\":\".\",\"maxResults\":20}}",
    "{\"type\":\"TOOL_CALL\",\"toolName\":\"read_file\",\"input\":{\"path\":\"demo.txt\",\"maxLines\":300}}",
    JSON.stringify({
      type: "APPLY_PATCH",
      description: "Add hello from mini-agent to demo.txt",
      patch: [
        "diff --git a/demo.txt b/demo.txt",
        "--- a/demo.txt",
        "+++ b/demo.txt",
        "@@ -1 +1,2 @@",
        " demo file",
        "+hello from mini-agent",
        "",
      ].join("\n"),
    }),
    JSON.stringify({
      type: "RUN_COMMAND",
      executable: "echo",
      args: ["test passed"],
      description: "Run a lightweight verification command",
    }),
    "{\"type\":\"TOOL_CALL\",\"toolName\":\"git_diff\",\"input\":{}}",
    "{\"type\":\"FINAL\",\"summary\":\"Updated demo.txt and verified the change\",\"success\":true}",
  ];
}

function scriptedStandaloneCodeFileResponses(): string[] {
  return [
    "{\"type\":\"PLAN\",\"message\":\"Create a new C++ file for the requested two-sum example\"}",
    JSON.stringify({
      type: "APPLY_PATCH",
      description: "Add a standalone two_sum.cpp program",
      patch: [
        "diff --git a/two_sum.cpp b/two_sum.cpp",
        "new file mode 100644",
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
        "+    std::cin >> x >> y;",
        "+    std::cout << twoSum(x, y) << std::endl;",
        "+    return 0;",
        "+}",
        "",
      ].join("\n"),
    }),
    "{\"type\":\"TOOL_CALL\",\"toolName\":\"git_diff\",\"input\":{}}",
    "{\"type\":\"FINAL\",\"summary\":\"Created two_sum.cpp in the repository\",\"success\":true}",
  ];
}

function stubDecisionResponses(responses: string[]) {
  return vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: responses.shift() ?? responses[responses.length - 1] } }],
  }), { status: 200 }));
}

function fakeDuckDuckGoHtml(): string {
  return [
    "<html><body>",
    "<div class=\"result\">",
    "<a class=\"result__a\" href=\"https://example.com/roco-news\">洛克王国更新公告</a>",
    "<div class=\"result__snippet\">洛克王国 2026 年 6 月 19 日更新内容。</div>",
    "</div>",
    "</body></html>",
  ].join("");
}

function fakeEdgDuckDuckGoHtml(): string {
  return [
    "<html><body>",
    "<div class=\"result\">",
    "<a class=\"result__a\" href=\"https://example.com/edg-honours\">EDward Gaming honours</a>",
    "<div class=\"result__snippet\">EDG won League of Legends Worlds 2021 and Valorant Champions 2024.</div>",
    "</div>",
    "</body></html>",
  ].join("");
}

function hasStringArrayEntry(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
