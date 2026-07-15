import fs from "node:fs/promises";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { SessionStore } from "../src/session/SessionStore.js";

const execFileAsync = promisify(execFile);

let tempRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-regression-"));
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("mini-agent CLI regression scenarios", () => {
  it("answers web capability questions locally without pretending there is no networking", async () => {
    process.chdir(tempRoot);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "你不能联网吗",
        "--model",
        "test-model",
        "--base-url",
        "https://llm.example/v1",
      ], { from: "user" });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("[answer]");
    expect(output).toContain("我有受控联网能力");
    expect(output).toContain("web_search");
    expect(output).toContain("fetch_url");
    expect(output).not.toContain("没有联网能力");
  });

  it("diagnoses npm package.json ENOENT as a wrong working directory", async () => {
    process.chdir(tempRoot);
    await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({
      scripts: {
        guess: "tsx src/guessing-game.ts",
      },
    }, null, 2), "utf8");

    const wrongDirectory = path.join(path.dirname(tempRoot), "mini-agent-parent");
    const pastedError = [
      `sid@ubuntu:${wrongDirectory}$ npm run guess`,
      "npm error code ENOENT",
      "npm error syscall open",
      `npm error path ${wrongDirectory}/package.json`,
      "npm error errno -2",
      `npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${wrongDirectory}/package.json'`,
      "npm error enoent This is related to npm not being able to find a file.",
    ].join("\n");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        pastedError,
        "--model",
        "test-model",
        "--base-url",
        "https://llm.example/v1",
      ], { from: "user" });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("[answer]");
    expect(output).toContain("运行目录问题");
    expect(output).toContain(wrongDirectory);
    expect(output).toContain(tempRoot);
    expect(output).toContain(`cd '${tempRoot}'`);
    expect(output).toContain(`npm --prefix '${tempRoot}' run guess`);
  });

  it("repairs web answers that contradict already executed web tools", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo.com/html")) {
        return new Response([
          "<html><body>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://example.com/market-close\">A股收盘：三大指数涨跌情况</a>",
          "<div class=\"result__snippet\">上证指数、深证成指、创业板指收盘行情。</div></div>",
          "<div class=\"result\"><a class=\"result__a\" href=\"https://finance.example/close-report\">市场收盘复核</a>",
          "<div class=\"result__snippet\">主要指数收盘数据复核。</div></div>",
          "</body></html>",
        ].join(""), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://example.com/market-close") {
        return new Response("<html><body><main>收盘数据显示，上证指数上涨0.30%，深证成指下跌0.10%，创业板指上涨0.20%。</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (urlText === "https://finance.example/close-report") {
        return new Response("<html><body><main>市场收盘复核：上证指数上涨0.30%，深证成指下跌0.10%，创业板指上涨0.20%。</main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";

      if (system.includes("web question planner")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                standaloneQuestion: "今天中国股市收盘后大盘指数涨跌情况",
                searchQueries: ["今天 A股 三大指数 收盘 涨跌 上证指数 深证成指 创业板指"],
                answerScope: "回答今天 A 股主要指数收盘涨跌。",
                sourceHints: ["major finance quote page"],
                answerInstructions: ["区分指数和涨跌幅。"],
                needsLiveData: true,
                confidence: "high",
              }),
            },
          }],
        }), { status: 200 });
      }

      if (user.includes("Previous answer was invalid")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "根据已抓取的网页内容，本轮 CLI 已经联网检索并读取来源。来源显示：上证指数上涨0.30%，深证成指下跌0.10%，创业板指上涨0.20%。",
            },
          }],
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "抱歉，我没有联网能力，需要你手动开启联网搜索按钮才能查看实时行情。",
          },
        }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "今天中国股市已经收盘了，查看一下大盘指数的涨跌情况",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] web_search");
      expect(output).toContain("[tool] fetch_url");
      expect(output).toContain("本轮 CLI 已经联网检索");
      expect(output).toContain("上证指数上涨0.30%");
      expect(output).not.toContain("没有联网能力");
      expect(output).not.toContain("联网搜索按钮");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("keeps explicit snippet requests in direct-answer mode", async () => {
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
          "给我一个 C++ 代码片段，计算两数之和，不要改文件",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[answer]");
      expect(output).not.toContain("[patch]");
      await expect(fs.stat(path.join(tempRoot, "two_sum.cpp"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("creates a repository file for algorithm implementation requests", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = stubDecisionResponses([
      "{\"type\":\"PLAN\",\"message\":\"Create a Python solution file for longest valid parentheses\"}",
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Add longest_valid_parentheses.py",
        patch: [
          "diff --git a/longest_valid_parentheses.py b/longest_valid_parentheses.py",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/longest_valid_parentheses.py",
          "@@ -0,0 +1,15 @@",
          "+def longest_valid_parentheses(s: str) -> int:",
          "+    stack = [-1]",
          "+    best = 0",
          "+    for index, ch in enumerate(s):",
          "+        if ch == '(':",
          "+            stack.append(index)",
          "+        else:",
          "+            stack.pop()",
          "+            if not stack:",
          "+                stack.append(index)",
          "+            else:",
          "+                best = max(best, index - stack[-1])",
          "+    return best",
          "",
        ].join("\n"),
      }),
      "{\"type\":\"TOOL_CALL\",\"toolName\":\"git_diff\",\"input\":{}}",
      "{\"type\":\"FINAL\",\"summary\":\"Created longest_valid_parentheses.py\",\"success\":true}",
    ]);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "帮我写个 最长有效括号",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[patch]");
      expect(output).toContain("[summary]");
      await expect(fs.readFile(path.join(tempRoot, "longest_valid_parentheses.py"), "utf8"))
        .resolves.toContain("def longest_valid_parentheses");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("saves the previous code answer into a real file on short follow-up", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Regression follow-up"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const calls: RequestInit[] = [];
    const responses = [
      [
        "```python",
        "def two_sum(a: int, b: int) -> int:",
        "    return a + b",
        "```",
      ].join("\n"),
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Save the previous code into solution.py",
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
      "{\"type\":\"FINAL\",\"summary\":\"Saved previous code into solution.py\",\"success\":true}",
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        choices: [{ message: { content: responses.shift() ?? "fallback" } }],
      }), { status: 200 });
    });
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
          "写进去",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[patch]");
      await expect(fs.readFile(path.join(tempRoot, "solution.py"), "utf8")).resolves.toContain("def two_sum");

      const secondBody = JSON.parse(String(calls[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondBody.messages[1]?.content).toContain("请把上一轮已经生成的 Python 代码真正写入仓库文件");
      expect(secondBody.messages[1]?.content).toContain("def two_sum(a: int, b: int) -> int:");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("answers file-write confirmation from session records instead of hallucinating older writes", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });

    const sessionStore = new SessionStore({ repoPath: tempRoot });
    const session = await sessionStore.createSession({ title: "Write confirmation regression" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "帮我写个 最长有效括号" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "FILE_CHANGE",
      payload: {
        files: [{ path: "src/generated_feature.ts", changeType: "ADDED", additions: 12, deletions: 0 }],
        diff: "diff --git a/src/generated_feature.ts b/src/generated_feature.ts",
      },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "已创建 src/generated_feature.ts，实现最长有效括号算法。",
        success: true,
        mode: "AGENT_LOOP",
      },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "写进去" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: "好的，将刚才的代码写入文件。" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "好的，将刚才的代码写入文件。",
        success: true,
        mode: "DIRECT_ANSWER",
      },
    });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "不应该调用模型" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "你写入了嘛？",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(output).toContain("没有查到上一轮请求对应的新文件写入记录");
      expect(output).toContain("最近一次文件变更是：src/generated_feature.ts");
      expect(output).not.toContain("是的，已经写入");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("keeps short algorithm follow-ups in repository-editing mode after an agent-loop task", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ name: "ts-demo" }, null, 2), "utf8");
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "index.ts"), "export {};\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: tempRoot });

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Algorithm follow-up"], { from: "user" });
    });
    const session = JSON.parse(sessionOutput) as { sessionId: string };

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const fetchMock = stubDecisionResponses([
      "{\"type\":\"PLAN\",\"message\":\"Create longest valid parentheses implementation\"}",
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Add src/longest_valid_parentheses.ts",
        patch: [
          "diff --git a/src/longest_valid_parentheses.ts b/src/longest_valid_parentheses.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/longest_valid_parentheses.ts",
          "@@ -0,0 +1,4 @@",
          "+export function longestValidParentheses(s: string): number {",
          "+  void s;",
          "+  return 0;",
          "+}",
          "",
        ].join("\n"),
      }),
      "{\"type\":\"FINAL\",\"summary\":\"Created longest valid parentheses implementation.\",\"success\":true}",
      "{\"type\":\"PLAN\",\"message\":\"Create median finder implementation\"}",
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Add src/median_finder.ts",
        patch: [
          "diff --git a/src/median_finder.ts b/src/median_finder.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/median_finder.ts",
          "@@ -0,0 +1,4 @@",
          "+export class MedianFinder {",
          "+  addNum(_num: number): void {}",
          "+  findMedian(): number { return 0; }",
          "+}",
          "",
        ].join("\n"),
      }),
      "{\"type\":\"FINAL\",\"summary\":\"Created median finder implementation.\",\"success\":true}",
    ]);
    vi.stubGlobal("fetch", fetchMock);

    try {
      await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "帮我写个 最长有效括号",
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
          "数据流的中位数呢",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[patch]");
      expect(output).toContain("[summary]");
      await expect(fs.readFile(path.join(tempRoot, "src", "median_finder.ts"), "utf8"))
        .resolves.toContain("export class MedianFinder");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("resolves short follow-up questions against the active session context", async () => {
    process.chdir(tempRoot);

    const sessionOutput = await captureStdout(async () => {
      await createProgram().parseAsync(["session", "create", "--title", "Regression direct follow-up"], { from: "user" });
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
        choices: [{ message: { content: responses.shift() ?? "fallback" } }],
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

      expect(output).toContain("葡萄牙也是传统强队");

      const secondBody = JSON.parse(String(calls[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondBody.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(secondBody.messages[1]?.content).toBe("西班牙是强队吗");
      expect(secondBody.messages[2]?.content).toBe("是的，西班牙是传统强队。");
      expect(secondBody.messages[3]?.content).toContain("Resolved current request: 葡萄牙是强队吗");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("reads repository evidence before summarizing a project", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.mkdir(path.join(tempRoot, "src", "cli"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "README.md"), "# Demo Agent\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({
      name: "demo-agent",
      scripts: { build: "tsc -p tsconfig.json" },
    }, null, 2), "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "cli", "index.ts"), "export const createProgram = () => 'cli';\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const requestBodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> });
        return new Response(JSON.stringify({
          choices: [{ message: { content: "这是一个 TypeScript CLI 项目。" } }],
        }), { status: 200 });
      })
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> });
        return new Response(JSON.stringify({
          choices: [{ message: { content: "CLI 入口在 `src/cli/index.ts`，README.md 和 package.json 说明了项目定位。" } }],
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
      expect(output).toContain("[summary]");

      const firstPrompt = requestBodies[0]?.messages?.find((message) => message.role === "user")?.content ?? "";
      expect(firstPrompt).toContain("Repository analysis instructions:");
      expect(firstPrompt).toContain("File: README.md");
      expect(firstPrompt).toContain("File: package.json");
      expect(firstPrompt).toContain("File: src/cli/index.ts");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
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

function stubDecisionResponses(responses: string[]) {
  return vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: responses.shift() ?? responses[responses.length - 1] ?? "" } }],
  }), { status: 200 }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
