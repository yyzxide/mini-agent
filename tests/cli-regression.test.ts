import fs from "node:fs/promises";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { TaskDiffStore } from "../src/diff/TaskDiffStore.js";
import { EventStore } from "../src/session/EventStore.js";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("mini-agent CLI regression scenarios", () => {
  it("retrieves an older disputed assistant claim and repairs a denial before output", async () => {
    process.chdir(tempRoot);
    const sessionStore = new SessionStore({ repoPath: tempRoot });
    const eventStore = new EventStore({ repoPath: tempRoot });
    const session = await sessionStore.createSession({ title: "conversation audit" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "第三章有什么特殊能力？" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: "击败守门者以后会获得星核变身。" },
    });
    for (let index = 0; index < 18; index += 1) {
      await sessionStore.appendRecord(session.sessionId, {
        type: index % 2 === 0 ? "USER_MESSAGE" : "ASSISTANT_MESSAGE",
        payload: { content: `无关历史消息 ${String(index)}` },
      });
    }
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "钥匙不是在下一章吗？" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: "对，钥匙是在下一章获得的。" },
    });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      "我之前没有说过会获得星核变身，我只是说可以击败守门者。",
      "我确实说过“会获得星核变身”。这条说法没有可靠证据，我撤回它。",
    ];
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: responses.shift() ?? "" } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "这个作品哪来的星核变身？以及你说的各种变身",
          "--session",
          session.sessionId,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("prior-response audit");
      expect(output).toContain("matched 1 prior assistant message(s)");
      expect(output).toContain("我确实说过");
      expect(output).toContain("撤回");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBodies[0]?.messages.some((message) =>
        message.role === "assistant" && message.content.includes("获得星核变身"),
      )).toBe(true);
      expect(requestBodies[1]?.messages.at(-1)?.content)
        .toContain("Conversation consistency revision required");
      expect((await eventStore.readEvents(session.sessionId)).map((event) => event.type))
        .toContain("PRIOR_RESPONSE_CONSISTENCY_RETRY");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("creates a clickable task changes artifact for newly written documents", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Create the requested notes document",
        patch: [
          "diff --git a/docs/notes.md b/docs/notes.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/docs/notes.md",
          "@@ -0,0 +1,3 @@",
          "+# Notes",
          "+",
          "+Created by Mini Agent.",
          "",
        ].join("\n"),
      }),
      JSON.stringify({ type: "TOOL_CALL", toolName: "git_diff", input: {} }),
      JSON.stringify({ type: "FINAL", summary: "已创建 docs/notes.md。", success: true }),
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? "" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "创建 docs/notes.md 文档",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      const sessionId = output.match(/\[session\]\s+([^\s]+)/)?.[1];
      expect(sessionId).toBeDefined();
      expect(output).toContain("[changes] 1 file · +3 -0");
      expect(output).toContain("A docs/notes.md");
      expect(output).toContain(`mini-agent diff --session ${sessionId}`);
      expect(output).not.toContain("+Created by Mini Agent.");

      const artifact = await new TaskDiffStore(tempRoot).latest(sessionId!);
      expect(artifact?.files[0]).toEqual(expect.objectContaining({
        path: "docs/notes.md",
        changeType: "ADDED",
      }));
      expect(artifact?.unifiedDiff).toContain("+Created by Mini Agent.");

      const diffOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["diff", "--session", sessionId!], { from: "user" });
      });
      expect(diffOutput).toContain("diff --git a/docs/notes.md b/docs/notes.md");
      expect(diffOutput).toContain("+Created by Mini Agent.");

      const events = await new EventStore({ repoPath: tempRoot }).readEvents(sessionId!);
      expect(events.map((event) => event.type)).toContain("CHANGES_READY");
      const records = await new SessionStore({ repoPath: tempRoot }).readRecords(sessionId!);
      expect(records.map((record) => record.type)).toContain("TASK_DIFF");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("answers web capability questions locally without pretending there is no networking", async () => {
    process.chdir(tempRoot);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outputs: string[] = [];
    for (const task of ["你不能联网吗", "你不能联网？"]) {
      outputs.push(await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          task,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      }));
    }
    const output = outputs.join("\n");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("[answer]");
    expect(output).toContain("支持受控联网研究");
    expect(output).toContain("web_search");
    expect(output).toContain("fetch_url");
    expect(output).not.toContain("没有联网能力");
  });

  it("reports overall capabilities locally instead of generalizing a direct-response contract", async () => {
    process.chdir(tempRoot);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "你可以干啥",
        "--model",
        "test-model",
        "--base-url",
        "https://llm.example/v1",
      ], { from: "user" });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("web_search");
    expect(output).toContain("仓库文件修改");
    expect(output).toContain("apply_patch");
    expect(output).not.toContain("不能修改文件");
    expect(output).not.toContain("不能上网搜索");
  });

  it("explains a previous false capability denial without entering web research", async () => {
    process.chdir(tempRoot);
    const sessionStore = new SessionStore({ repoPath: tempRoot });
    const session = await sessionStore.createSession({ title: "capability correction" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "你可以干啥" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: "我不能修改文件，也不能上网搜索。" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "那你为什么说自己不能联网？",
        "--session",
        session.sessionId,
        "--model",
        "test-model",
        "--base-url",
        "https://llm.example/v1",
      ], { from: "user" });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("上一轮回答错了");
    expect(output).toContain("Capability Registry 才是权威事实源");
    expect(output).toContain("不应该为了证明联网能力");
    expect(output).toContain("搜索天气");
    expect(output).not.toContain("[tool] web_search");
    expect(output).not.toContain("FINAL_WITHOUT_WEB_SEARCH");
  });

  it("answers RAG capability questions from product facts instead of historical memory", async () => {
    process.chdir(tempRoot);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "你有rag系统吗",
        "--model",
        "test-model",
        "--base-url",
        "https://llm.example/v1",
      ], { from: "user" });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("[answer]");
    expect(output).toContain("文档知识库 RAG");
    expect(output).toContain("knowledge_search");
    expect(output).toContain(".mini-agent/rag/index.jsonl");
    expect(output).toContain(".mini-agent/memory/index.jsonl");
    expect(output).not.toContain("历史任务摘要被存入向量数据库");
  });

  it("routes explicit indexed-knowledge questions through knowledge_search", async () => {
    process.chdir(tempRoot);
    await fs.mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "docs", "upload-policy.md"),
      "# 上传策略\n\n所有分片上传都必须校验 SHA-256。\n",
      "utf8",
    );
    await captureStdout(async () => {
      await createProgram().parseAsync(["rag", "ingest", "docs"], { from: "user" });
    });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      JSON.stringify({
        type: "FINAL",
        summary: "我记得历史任务里提到过上传策略。",
        success: true,
      }),
      JSON.stringify({
        type: "TOOL_CALL",
        toolName: "knowledge_search",
        input: { query: "上传策略 SHA-256" },
      }),
      JSON.stringify({
        type: "FINAL",
        summary: "知识库说明所有分片上传都必须校验 SHA-256。",
        success: true,
      }),
      JSON.stringify({
        type: "FINAL",
        summary: "知识库说明所有分片上传都必须校验 SHA-256（docs/upload-policy.md#L1-L3）。",
        success: true,
      }),
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? "" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "根据已索引知识库回答上传策略是什么",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] knowledge_search");
      expect(output).toContain("docs/upload-policy.md#L1-L3");
      expect(output).not.toContain("[answer]");
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const sessionId = output.match(/\[session\]\s+([^\s]+)/)?.[1];
      expect(sessionId).toBeDefined();
      const records = await new SessionStore({ repoPath: tempRoot }).readRecords(sessionId!);
      expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_KNOWLEDGE_SEARCH")))
        .toBe(true);
      expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_KNOWLEDGE_CITATION")))
        .toBe(true);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
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
    expect(output).toContain(`cd ${tempRoot}`);
    expect(output).toContain(`npm --prefix ${tempRoot} run guess`);
  });

  it("keeps web research inside AgentLoop and rejects an ungrounded final answer", async () => {
    process.chdir(tempRoot);

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const decisions = [
      { type: "TOOL_CALL", toolName: "web_search", input: { query: "今天 A股 三大指数 收盘", maxResults: 6 } },
      { type: "TOOL_CALL", toolName: "fetch_url", input: { url: "https://example.com/market-close" } },
      { type: "TOOL_CALL", toolName: "fetch_url", input: { url: "https://finance.example/close-report" } },
      { type: "FINAL", summary: "抱歉，我没有联网能力。", success: true },
      {
        type: "FINAL",
        summary: "本轮 CLI 已经联网检索。上证指数上涨0.30%，来源：https://example.com/market-close",
        success: true,
      },
    ];

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);

      if (urlText.includes("duckduckgo")) {
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

      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(decisions.shift()) } }],
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
      JSON.stringify({
        type: "RUN_COMMAND",
        executable: "python3",
        args: ["-m", "py_compile", "longest_valid_parentheses.py"],
        description: "Verify the generated Python source",
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
      JSON.stringify({
        type: "RUN_COMMAND",
        executable: "python3",
        args: ["-m", "py_compile", "solution.py"],
        description: "Verify the saved Python source",
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
      expect(secondBody.messages.at(-1)?.content).toContain("请把上一轮已经生成的 Python 代码真正写入仓库文件");
      expect(secondBody.messages.at(-1)?.content).toContain("def two_sum(a: int, b: int) -> int:");
      expect(secondBody.messages).toContainEqual({
        role: "assistant",
        content: expect.stringContaining("def two_sum(a: int, b: int) -> int:"),
      });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("keeps an explicit documentation write in agent mode even after a direct-answer turn", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.mkdir(path.join(tempRoot, "docs"), { recursive: true });
    const sessionStore = new SessionStore({ repoPath: tempRoot });
    const session = await sessionStore.createSession({ title: "Documentation routing regression" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "先介绍一下这个项目" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: "这是一个本地 Coding Agent。" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: { summary: "这是一个本地 Coding Agent。", success: true, mode: "DIRECT_ANSWER" },
    });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Create the self design document",
        patch: [
          "diff --git a/docs/self_structure_design.md b/docs/self_structure_design.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/docs/self_structure_design.md",
          "@@ -0,0 +1,2 @@",
          "+# 自身结构设计",
          "+本文说明 Agent 的路由、工具与记忆边界。",
          "",
        ].join("\n"),
      }),
      JSON.stringify({ type: "TOOL_CALL", toolName: "git_diff", input: {} }),
      JSON.stringify({ type: "FINAL", summary: "已创建自身结构设计文档。", success: true }),
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? "" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "那你帮我写一个自身的设计文档",
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
      expect(output).not.toContain("[answer]");
      await expect(fs.readFile(path.join(tempRoot, "docs", "self_structure_design.md"), "utf8"))
        .resolves.toContain("自身结构设计");
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

  it("answers artifact-location follow-ups from the latest FILE_CHANGE without calling the model", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await fs.writeFile(path.join(tempRoot, "demo_app.html"), "<!doctype html>\n", "utf8");

    const sessionStore = new SessionStore({ repoPath: tempRoot });
    const session = await sessionStore.createSession({ title: "Artifact location regression" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "写一个贪吃蛇游戏的代码文件" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "FILE_CHANGE",
      payload: {
        files: [{ path: "demo_app.html", changeType: "ADDED", additions: 1, deletions: 0 }],
      },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "已成功创建贪吃蛇游戏文件 demo_app.html。",
        success: true,
        mode: "AGENT_LOOP",
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "run",
        "在哪里",
        "--session",
        session.sessionId,
        "--model",
        "test-model",
        "--base-url",
        "https://llm.example/v1",
      ], { from: "user" });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain("[follow-up] artifact location · source=FILE_CHANGE");
    expect(output).toContain("demo_app.html · LLM skipped");
    expect(output).toContain(`[answer]\n上一轮创建的文件在 \`${path.join(tempRoot, "demo_app.html")}\`。`);
    expect(output).not.toContain("我就在你面前的终端里");
    const events = await new EventStore({ repoPath: tempRoot }).readEvents(session.sessionId);
    expect(events.map((event) => event.type)).toContain("FOLLOW_UP_RESOLVED");
    const records = await sessionStore.readRecords(session.sessionId);
    expect(records.some((record) => record.type === "LLM_USAGE" && record.payload.mode === "agent_single_shot"))
      .toBe(false);
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
      JSON.stringify({
        type: "RUN_COMMAND",
        executable: "tsc",
        args: ["--noEmit", "--skipLibCheck", "src/longest_valid_parentheses.ts"],
        description: "Verify longest valid parentheses source",
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
      JSON.stringify({
        type: "RUN_COMMAND",
        executable: "tsc",
        args: ["--noEmit", "--skipLibCheck", "src/median_finder.ts"],
        description: "Verify median finder source",
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
    const decisions = [
      { type: "TOOL_CALL", toolName: "list_files", input: { path: ".", maxDepth: 3 } },
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "README.md" } },
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "package.json" } },
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "src/cli/index.ts" } },
      { type: "TOOL_CALL", toolName: "git_status", input: {} },
      {
        type: "FINAL",
        summary: "CLI 入口在 `src/cli/index.ts`，README.md 和 package.json 说明了项目定位。",
        success: true,
      },
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(decisions.shift()) } }],
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

      const prompts = requestBodies.flatMap((body) => body.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) => message.content ?? "")
        .join("\n");
      expect(prompts).toContain("Task kind: REPOSITORY_INVESTIGATION");
      expect(prompts).toContain("Output kind: REPOSITORY_ANALYSIS");
      expect(prompts).toContain("README.md");
      expect(prompts).toContain("package.json");
      expect(prompts).toContain("src/cli/index.ts");
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
