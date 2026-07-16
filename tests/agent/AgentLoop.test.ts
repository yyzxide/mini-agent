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
import { checkpointToPayload, createAgentCheckpoint } from "../../src/agent/AgentCheckpoint.js";
import { AgentState } from "../../src/agent/AgentState.js";
import type { SubAgentCoordinator } from "../../src/agent/SubAgentTypes.js";
import { DEFAULT_MULTI_AGENT_POLICY } from "../../src/agent/SubAgentTypes.js";

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
      "AGENT_CHECKPOINT",
      "TOOL_CALL",
      "TOOL_RESULT",
      "COMMAND_RESULT",
      "FILE_CHANGE",
      "DIFF_SUMMARY",
      "TASK_SUMMARY",
    ]));
    expect(recordTypes(records)).not.toContain("ASSISTANT_MESSAGE");
    expect(toolNames(records)).toEqual(expect.arrayContaining(["search_code", "read_file", "apply_patch", "git_diff"]));

    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toEqual(expect.arrayContaining([
      "CONTEXT_BUILT",
      "AGENT_CHECKPOINTED",
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

  it("persists read-only child evidence and returns it to the parent context", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const client = new ScriptedLlmClient([
      {
        type: "DELEGATE_READONLY",
        reason: "Inspect architecture and risks independently",
        tasks: [
          { id: "architecture", role: "repository_analyst", objective: "Map the loop", focusPaths: ["src/agent"] },
          { id: "risks", role: "risk_reviewer", objective: "Review isolation", focusPaths: ["src/session"] },
        ],
      },
      { type: "FINAL", success: true, summary: "Analysis completed from validated child evidence." },
    ]);
    const coordinator: SubAgentCoordinator = {
      runBatch: async ({ tasks }) => ({
        batchId: "batch-1",
        status: "COMPLETED",
        results: tasks.map((task) => ({
          taskId: task.id,
          role: task.role,
          objective: task.objective,
          status: "COMPLETED",
          summary: `Evidence for ${task.id}`,
          evidence: [{ path: task.focusPaths[0] ?? "src" }],
          toolsCalled: ["read_file"],
          usage: {
            steps: 1,
            llmCalls: 1,
            toolCalls: 1,
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cachedPromptTokens: 0,
            reasoningTokens: 0,
            usageAvailable: true,
          },
        })),
        usage: {
          steps: 2,
          llmCalls: 2,
          toolCalls: 2,
          promptTokens: 20,
          completionTokens: 10,
          totalTokens: 30,
          cachedPromptTokens: 0,
          reasoningTokens: 0,
          usageAvailable: true,
        },
        maxParallelAgents: 2,
        durationMs: 20,
      }),
    };
    const loop = createLoop({ sessionStore, eventStore, llmClient: client, subAgentCoordinator: coordinator });

    const result = await loop.run({
      userGoal: "Analyze the agent architecture",
      autoApprove: true,
      nonInteractive: true,
      multiAgent: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });

    expect(result).toMatchObject({ success: true, delegationBatches: 1, subAgents: 2 });
    expect(client.getCallInputs()[1]?.context).toContain("Read-only sub-agent evidence");
    expect(client.getCallInputs()[1]?.context).toContain("Evidence for architecture");
    expect(recordTypes(await sessionStore.readRecords(result.sessionId))).toContain("SUBAGENT_BATCH_RESULT");
    expect(eventTypes(await eventStore.readEvents(result.sessionId))).toEqual(expect.arrayContaining([
      "SUBAGENT_BATCH_STARTED",
      "SUBAGENT_BATCH_FINISHED",
    ]));
  });

  it("restores an interrupted checkpoint and isolates it after successful completion", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const session = await sessionStore.createSession({ title: "interrupted file task" });
    await fs.writeFile(path.join(repoPath, "notes.txt"), "hello\n", "utf8");
    const interruptedState = new AgentState({
      sessionId: session.sessionId,
      runId: "interrupted-run",
      repoPath,
      userGoal: "Create notes.txt containing hello.",
    });
    interruptedState.addPatchResult({
      description: "Create notes.txt",
      patch: "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hello\n",
      result: { success: true },
    });
    const checkpoint = createAgentCheckpoint({ state: interruptedState, inFlightAction: "patch:Create notes.txt" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "AGENT_CHECKPOINT",
      payload: checkpointToPayload(checkpoint),
    });

    const resumedClient = new ScriptedLlmClient([
      { type: "TOOL_CALL", toolName: "git_status", input: {} },
      { type: "FINAL", success: true, summary: "Confirmed notes.txt exists after recovery." },
    ]);
    const resumed = await createLoop({ sessionStore, eventStore, llmClient: resumedClient }).run({
      sessionId: session.sessionId,
      userGoal: "Create notes.txt containing hello.",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(resumed.success).toBe(true);
    expect(resumedClient.getCallInputs()[0]?.state).toMatchObject({
      runId: "interrupted-run",
      recoveredFromCheckpoint: true,
    });
    expect(resumedClient.getCallInputs()[0]?.context).toContain("Recovered after interruption during patch:Create notes.txt");
    expect(resumedClient.getCallInputs()[0]?.context).toContain("notes.txt");
    expect(eventTypes(await eventStore.readEvents(session.sessionId))).toContain("AGENT_STATE_RESTORED");

    const nextClient = new ScriptedLlmClient([{ type: "FINAL", success: true, summary: "A separate task." }]);
    const next = await createLoop({ sessionStore, eventStore, llmClient: nextClient }).run({
      sessionId: session.sessionId,
      userGoal: "Explain the next independent task.",
      autoApprove: true,
      nonInteractive: true,
    });
    expect(next.success).toBe(true);
    expect(nextClient.getCallInputs()[0]?.state.recoveredFromCheckpoint).toBe(false);
  });

  it("records last error context when a command fails and continues", async () => {
    const failScriptPath = path.join(repoPath, "fail-test.mjs");
    const passScriptPath = path.join(repoPath, "pass-test.mjs");
    await fs.writeFile(failScriptPath, "process.exit(1);\n", "utf8");
    await fs.writeFile(passScriptPath, "process.exit(0);\n", "utf8");
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
        {
          type: "RUN_COMMAND",
          executable: process.execPath,
          args: [passScriptPath, "npm test"],
          description: "run replacement test",
        },
        { type: "FINAL", success: true, summary: "Recovered with a passing replacement test." },
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
    expect(eventTypes(events)).toContain("TEST_PASSED");
    expect(eventTypes(events)).toContain("TASK_FINISHED");
  });

  it("blocks successful completion while the latest test result is failing", async () => {
    const failScriptPath = path.join(repoPath, "fail-verification.mjs");
    await fs.writeFile(failScriptPath, "process.exit(1);\n", "utf8");
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        {
          type: "RUN_COMMAND",
          executable: process.execPath,
          args: [failScriptPath, "pnpm test"],
          description: "simulate failed verification",
        },
        { type: "FINAL", success: true, summary: "verification finished" },
        { type: "FAILED", error: "The verification command did not pass." },
      ]),
    });

    const result = await loop.run({
      userGoal: "verify the current behavior",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("did not pass");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_IGNORES_VERIFICATION_FAILURE"))).toBe(true);
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
        {
          type: "RUN_COMMAND",
          executable: "tsc",
          args: ["--noEmit", "--skipLibCheck", "src/answer.ts"],
          description: "Verify the generated TypeScript source",
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
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_REQUIRED_VERIFICATION"))).toBe(true);
  });

  it("invalidates a passing verification when a later source patch is applied", async () => {
    await fs.writeFile(path.join(repoPath, "value.mjs"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", "value.mjs"], { cwd: repoPath });
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        {
          type: "RUN_COMMAND",
          executable: "node",
          args: ["--check", "value.mjs"],
          description: "Run verification before editing",
        },
        {
          type: "APPLY_PATCH",
          description: "Update exported value",
          patch: "diff --git a/value.mjs b/value.mjs\n--- a/value.mjs\n+++ b/value.mjs\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        },
        { type: "FINAL", success: true, summary: "Updated value.mjs and tests passed." },
        {
          type: "RUN_COMMAND",
          executable: "node",
          args: ["--check", "value.mjs"],
          description: "Rerun verification after editing",
        },
        { type: "FINAL", success: true, summary: "Updated value.mjs and reran verification." },
      ]),
    });

    const result = await loop.run({
      userGoal: "Update value.mjs to export 2 and verify its syntax.",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "value.mjs"), "utf8")).resolves.toContain("value = 2");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITH_STALE_VERIFICATION"))).toBe(true);
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
        {
          type: "RUN_COMMAND",
          executable: "tsc",
          args: ["--noEmit", "--skipLibCheck", "src/median_finder.ts"],
          description: "Verify the generated TypeScript source",
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

  it("does not allow documentation creation tasks to finish before a file is written", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "FINAL", success: true, summary: "设计文档如下。" },
        {
          type: "APPLY_PATCH",
          description: "Create the design document",
          patch: [
            "diff --git a/SELF_STRUCTURE_DESIGN.md b/SELF_STRUCTURE_DESIGN.md",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/SELF_STRUCTURE_DESIGN.md",
            "@@ -0,0 +1,2 @@",
            "+# 自身结构设计",
            "+这是设计说明。",
            "",
          ].join("\n"),
        },
        { type: "FINAL", success: true, summary: "已创建 SELF_STRUCTURE_DESIGN.md。" },
      ]),
    });

    const result = await loop.run({
      userGoal: "那你帮我写一个自身的设计文档",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "SELF_STRUCTURE_DESIGN.md"), "utf8"))
      .resolves.toContain("自身结构设计");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_REPOSITORY_CHANGE"))).toBe(true);
  });

  it("does not allow an indexed-knowledge answer to invent evidence after an empty search", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "knowledge_search", input: { query: "上传策略" } },
        { type: "FINAL", success: true, summary: "上传必须校验 SHA-256。" },
        { type: "FINAL", success: true, summary: "知识库中没有找到相关证据，无法回答。" },
      ]),
    });

    const result = await loop.run({
      userGoal: "请用知识库查一下上传策略",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.summary).toContain("没有找到相关证据");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload)
      .includes("FINAL_IGNORES_INSUFFICIENT_KNOWLEDGE"))).toBe(true);
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

  it("uses only read-only tools and completes a write-task plan without changing files", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const client = new ScriptedLlmClient([
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "demo.txt", maxLines: 20 } },
      { type: "FINAL", success: true, summary: "1. Update demo.txt. 2. Run tests. Risk: verify current content." },
    ]);
    const loop = createLoop({ sessionStore, llmClient: client });
    const before = await fs.readFile(path.join(repoPath, "demo.txt"), "utf8");

    const result = await loop.run({
      userGoal: "修改 demo.txt 并测试",
      operatingMode: "PLAN",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.finalDiff).toBe("");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe(before);
    expect(client.getCallInputs()[0]?.state.operatingMode).toBe("PLAN");
    expect(client.getCallInputs()[0]?.availableTools.map((tool) => tool.name)).not.toContain("apply_patch");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.find((record) => record.type === "TASK_SUMMARY")?.payload.mode).toBe("PLAN");
    expect(records.some((record) => record.type === "DIFF_SUMMARY")).toBe(false);
  });

  it("hard-blocks patch and command decisions in plan mode", async () => {
    const eventStore = new EventStore({ repoPath });
    const markerPath = path.join(repoPath, "plan-marker.txt");
    const loop = createLoop({
      eventStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "apply_patch", input: { patch: "invalid" } },
        {
          type: "APPLY_PATCH",
          description: "must be blocked",
          patch: "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1,2 @@\n demo file\n+blocked\n",
        },
        { type: "RUN_COMMAND", executable: process.execPath, args: [markerPath], description: "must be blocked" },
        { type: "RUN_COMMAND", executable: "echo", args: ["blocked"], description: "blocked again" },
      ]),
    });

    const result = await loop.run({
      userGoal: "plan a dangerous change",
      operatingMode: "PLAN",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("demo file\n");
    await expect(fs.access(markerPath)).rejects.toBeDefined();
    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).not.toContain("PATCH_APPLY_STARTED");
    expect(eventTypes(events)).not.toContain("COMMAND_STARTED");
  });
});

function createLoop(options: {
  sessionStore?: SessionStore;
  eventStore?: EventStore;
  llmClient?: LlmClient;
  onProgress?: (event: AgentProgressEvent) => void;
  subAgentCoordinator?: SubAgentCoordinator;
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
    ...(options.subAgentCoordinator ? { subAgentCoordinator: options.subAgentCoordinator } : {}),
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
      executable: "git",
      args: ["diff", "--check"],
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
