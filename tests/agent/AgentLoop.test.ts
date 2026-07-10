import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision } from "../../src/agent/AgentDecision.js";
import { AgentLoop } from "../../src/agent/AgentLoop.js";
import type { AgentProgressEvent } from "../../src/agent/AgentLoop.js";
import { CommandRunner } from "../../src/command/CommandRunner.js";
import { ContextBuilder } from "../../src/context/ContextBuilder.js";
import type { LlmClient } from "../../src/llm/LlmClient.js";
import { ScriptedLlmClient } from "../../src/eval/ScriptedLlmClient.js";
import { PatchManager } from "../../src/patch/PatchManager.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";
import { EventStore } from "../../src/session/EventStore.js";
import { SessionStore } from "../../src/session/SessionStore.js";
import type { EventRecord, SessionRecord } from "../../src/session/SessionTypes.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

const execFileAsync = promisify(execFile);

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-loop-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "demo.txt"), "demo file\n", "utf8");
  await execFileAsync("git", ["add", "demo.txt"], { cwd: repoPath });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("AgentLoop", () => {
  it("runs a complete scripted model flow and records session data", async () => {
    const progress: AgentProgressEvent[] = [];
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      eventStore,
      onProgress: (event) => {
        progress.push(event);
      },
    });

    const result = await loop.run({
      userGoal: "give demo.txt hello from mini-agent",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(result.finalDiff).toContain("+hello from mini-agent");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toContain("hello from mini-agent");

    const sessions = await sessionStore.listSessions();
    expect(sessions.map((session) => session.sessionId)).toContain(result.sessionId);

    const records = await sessionStore.readRecords(result.sessionId);
    expect(recordTypes(records)).toEqual(expect.arrayContaining([
      "USER_MESSAGE",
      "ASSISTANT_MESSAGE",
      "TOOL_CALL",
      "TOOL_RESULT",
      "COMMAND_RESULT",
      "FILE_CHANGE",
      "DIFF_SUMMARY",
      "TASK_SUMMARY",
    ]));
    expect(toolNames(records)).toEqual(expect.arrayContaining(["search_code", "read_file", "apply_patch", "git_diff"]));

    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toEqual(expect.arrayContaining([
      "TOOL_CALL_STARTED",
      "TOOL_CALL_FINISHED",
      "PATCH_APPLY_STARTED",
      "PATCH_APPLY_FINISHED",
      "COMMAND_STARTED",
      "COMMAND_FINISHED",
      "TASK_FINISHED",
      "DIFF_GENERATED",
    ]));
    expect(progress.map((event) => event.type)).toEqual(expect.arrayContaining([
      "session",
      "plan",
      "tool",
      "patch",
      "command",
      "diff",
      "summary",
    ]));
  });

  it("fails when maxSteps is reached", async () => {
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({ eventStore });

    const result = await loop.run({
      userGoal: "demo: stop early",
      maxSteps: 1,
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("max steps");

    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toContain("TASK_FAILED");
  });

  it("records last error context when a command fails and continues", async () => {
    const failScriptPath = path.join(repoPath, "fail-test.mjs");
    await fs.writeFile(failScriptPath, "process.exit(1);\n", "utf8");
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      eventStore,
        llmClient: new ScriptedLlmClient([
        { type: "PLAN", message: "Run a failing test command." },
        {
          type: "RUN_COMMAND",
          executable: process.execPath,
          args: [failScriptPath, "npm test"],
          description: "simulate test failure",
        },
        { type: "FINAL", success: true, summary: "Finished after recording command failure." },
      ]),
    });

    const result = await loop.run({
      userGoal: "simulate command failure",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);

    const records = await sessionStore.readRecords(result.sessionId);
    expect(recordTypes(records)).toContain("ERROR");
    expect(records.some((record) => JSON.stringify(record.payload).includes("Command failed with exit code 1"))).toBe(true);

    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toContain("TEST_FAILED");
    expect(eventTypes(events)).toContain("TASK_FINISHED");
  });

  it("fails in nonInteractive mode when patch approval is required", async () => {
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({ eventStore });

    const result = await loop.run({
      userGoal: "demo: needs patch approval",
      autoApprove: false,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("requires approval");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.not.toContain("hello from mini-agent");

    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toContain("PATCH_APPLY_FAILED");
    expect(eventTypes(events)).toContain("TASK_FAILED");
  });

  it("requires explicit approval for shell-like structured commands", async () => {
    const loop = createLoop({
      llmClient: new ScriptedLlmClient([
        {
          type: "RUN_COMMAND",
          executable: "sh",
          args: ["-c", "echo bypass"],
          description: "try structured shell bypass",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: "try shell bypass",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("explicit approval");
  });

  it("records an error when the model requests an unknown tool", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "not_a_tool", input: {} },
        { type: "FINAL", success: true, summary: "Recovered from bad tool call." },
      ]),
    });

    const result = await loop.run({
      userGoal: "request an unknown tool",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("Tool not found: not_a_tool"))).toBe(true);
  });

  it("records an error when the model sends invalid tool input", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "read_file", input: { path: "demo.txt", maxLines: 999 } },
        { type: "FINAL", success: true, summary: "Recovered from bad tool input." },
      ]),
    });

    const result = await loop.run({
      userGoal: "send invalid tool input",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("Tool input validation failed"))).toBe(true);
  });

  it("does not allow file-writing tasks to finish successfully without a patch", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "FINAL", success: true, summary: "Created src/answer.ts." },
        {
          type: "APPLY_PATCH",
          description: "Create src/answer.ts",
          patch: [
            "diff --git a/src/answer.ts b/src/answer.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/answer.ts",
            "@@ -0,0 +1,3 @@",
            "+export function answer(): number {",
            "+  return 42;",
            "+}",
            "",
          ].join("\n"),
        },
        { type: "FINAL", success: true, summary: "Created src/answer.ts." },
      ]),
    });

    const result = await loop.run({
      userGoal: "帮我写个 TypeScript 函数代码",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "src", "answer.ts"), "utf8")).resolves.toContain("answer");

    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_REPOSITORY_CHANGE"))).toBe(true);
  });

  it("blocks redundant clarification when save-to-file follow-up already includes code", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "ASK_USER", message: "请提供要写入什么内容到哪个文件？" },
        {
          type: "APPLY_PATCH",
          description: "Create src/median_finder.ts",
          patch: [
            "diff --git a/src/median_finder.ts b/src/median_finder.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/median_finder.ts",
            "@@ -0,0 +1,3 @@",
            "+export class MedianFinder {",
            "+  addNum(_num: number): void {}",
            "+}",
            "",
          ].join("\n"),
        },
        { type: "FINAL", success: true, summary: "Created src/median_finder.ts." },
      ]),
    });

    const result = await loop.run({
      userGoal: [
        "请把上一轮已经生成的 TypeScript 代码真正写入仓库文件，而不是继续只在对话里展示。",
        "需要落盘的代码如下：",
        "```ts",
        "export class MedianFinder {}",
        "```",
      ].join("\n"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "src", "median_finder.ts"), "utf8")).resolves.toContain("MedianFinder");

    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("REDUNDANT_FILE_WRITE_QUESTION"))).toBe(true);
  });

  it("can use web_search for non-code research tasks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      "<html><body>",
      "<div class=\"result\">",
      "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2Fexample.com%2Fresearch\">Research Result</a>",
      "<a class=\"result__snippet\">A current public web result.</a>",
      "</div>",
      "</body></html>",
    ].join(""), { status: 200 })));
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "PLAN", message: "Search the web for the user's research question." },
        { type: "TOOL_CALL", toolName: "web_search", input: { query: "current research topic", maxResults: 3 } },
        { type: "FINAL", success: true, summary: "Found a relevant public web result." },
      ]),
    });

    const result = await loop.run({
      userGoal: "联网搜索一下 current research topic",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);

    const records = await sessionStore.readRecords(result.sessionId);
    expect(toolNames(records)).toContain("web_search");
    expect(records.some((record) => JSON.stringify(record.payload).includes("Research Result"))).toBe(true);
  });

  it("fails after too many consecutive model/action failures", async () => {
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({
      eventStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "missing_1", input: {} },
        { type: "TOOL_CALL", toolName: "missing_2", input: {} },
        { type: "TOOL_CALL", toolName: "missing_3", input: {} },
        { type: "TOOL_CALL", toolName: "missing_4", input: {} },
      ]),
    });

    const result = await loop.run({
      userGoal: "keep failing",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("failed too many consecutive steps");
    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toContain("TASK_FAILED");
  });
});

function createLoop(options: {
  sessionStore?: SessionStore;
  eventStore?: EventStore;
  llmClient?: LlmClient;
  onProgress?: (event: AgentProgressEvent) => void;
} = {}): AgentLoop {
  const sessionStore = options.sessionStore ?? new SessionStore({ repoPath });
  const eventStore = options.eventStore ?? new EventStore({ repoPath });

  return new AgentLoop({
    repoPath,
    llmClient: options.llmClient ?? new ScriptedLlmClient(scriptedDemoDecisions()),
    toolRegistry: createDefaultToolRegistry(),
    sessionStore,
    eventStore,
    commandRunner: new CommandRunner({ repoPath }),
    permissionManager: new PermissionManager({
      prompt: async () => "yes",
    }),
    patchManager: new PatchManager({ repoPath }),
    contextBuilder: new ContextBuilder({ repoPath }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

function scriptedDemoDecisions(): AgentDecision[] {
  return [
    {
      type: "PLAN",
      message: "Search demo.txt, apply a patch, run a verification command, then inspect diff.",
    },
    {
      type: "TOOL_CALL",
      toolName: "search_code",
      input: { query: "demo", path: ".", maxResults: 20 },
    },
    {
      type: "TOOL_CALL",
      toolName: "read_file",
      input: { path: "demo.txt", maxLines: 300 },
    },
    {
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
    },
    {
      type: "RUN_COMMAND",
      executable: "echo",
      args: ["test passed"],
      description: "Run a lightweight verification command",
    },
    {
      type: "TOOL_CALL",
      toolName: "git_diff",
      input: {},
    },
    {
      type: "FINAL",
      success: true,
      summary: "Updated demo.txt and verified the change.",
    },
  ];
}

function recordTypes(records: SessionRecord[]): string[] {
  return records.map((record) => record.type);
}

function eventTypes(events: EventRecord[]): string[] {
  return events.map((event) => event.type);
}

function toolNames(records: SessionRecord[]): string[] {
  return records
    .filter((record) => record.type === "TOOL_CALL")
    .map((record) => record.payload.toolName)
    .filter((toolName): toolName is string => typeof toolName === "string");
}
