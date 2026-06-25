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

    expect(commandNames).toEqual([
      "changes",
      "command",
      "config",
      "diff",
      "doctor",
      "git",
      "logs",
      "patch",
      "resume",
      "run",
      "session",
      "sessions",
      "status",
      "tool",
    ]);
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
    expect(output).toContain("[command] echo test passed");
    expect(output).toContain("[summary]");
    expect(fetchMock).toHaveBeenCalled();
    await expect(fs.readFile(path.join(tempRoot, "demo.txt"), "utf8")).resolves.toContain("hello from mini-agent");
  });

  it("answers standalone code requests without editing the repository", async () => {
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
          "写一个两数之和的C++代码",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).toContain("```cpp");
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

  it("uses previous web context to scope follow-up searches", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Web Memory"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
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
    "{\"type\":\"RUN_COMMAND\",\"command\":\"echo test passed\",\"description\":\"Run a lightweight verification command\"}",
    "{\"type\":\"TOOL_CALL\",\"toolName\":\"git_diff\",\"input\":{}}",
    "{\"type\":\"FINAL\",\"summary\":\"Updated demo.txt and verified the change\",\"success\":true}",
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
