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
import {
  createTestTaskContract,
  createTestTaskFrame,
} from "../helpers/TaskFrameContract.js";
import type { SubAgentCoordinator } from "../../src/agent/SubAgentTypes.js";
import { DEFAULT_MULTI_AGENT_POLICY } from "../../src/agent/SubAgentTypes.js";
import { fingerprintWorkingTree } from "../../src/agent/SubAgentWorktree.js";
import { createTaskFrameBootstrapContract } from "../../src/runtime/TaskFrameContract.js";

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
  it("runs a TaskFrame and model-selected repository action through one control chain", async () => {
    const passScriptPath = path.join(repoPath, "task-frame-pass.mjs");
    await fs.writeFile(passScriptPath, "process.exit(0);\n", "utf8");
    const progress: AgentProgressEvent[] = [];
    const decisionInputs: Parameters<LlmClient["chat"]>[0][] = [];
    let decisionIndex = 0;
    const decisions: AgentDecision[] = [
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "demo.txt" },
        reason: "Inspect the file before changing it",
      },
      {
        type: "APPLY_PATCH",
        description: "Apply the TaskFrame model-selected change",
        patch: [
          "diff --git a/demo.txt b/demo.txt",
          "--- a/demo.txt",
          "+++ b/demo.txt",
          "@@ -1 +1 @@",
          "-demo file",
          "+single control chain",
          "",
        ].join("\n"),
      },
      {
        type: "RUN_COMMAND",
        executable: process.execPath,
        args: [passScriptPath, "npm test"],
        description: "Verify the TaskFrame change",
      },
      {
        type: "FINAL",
        success: true,
        summary: "TaskFrame changed and verified demo.txt.",
      },
    ];
    const llmClient: LlmClient = {
      compileTaskFrame: async (input) => {
        expect(input.userGoal).toBe("把 demo.txt 改好并验证");
        return {
          success: true,
          text: JSON.stringify({
            version: 1,
            objective: "Change demo.txt and verify the result.",
            target: "REPOSITORY",
            effects: {
              answer: true,
              repositoryRead: true,
              repositoryWrite: "REQUIRED",
              webEvidence: false,
              knowledgeEvidence: false,
              commandExecution: true,
              verification: "TEST",
              delegation: false,
              mcp: false,
            },
            constraints: {
              readOnly: false,
              noWeb: false,
              noCommands: false,
              requireCompleteFileRead: false,
            },
            conversationEvidence: {
              requiresHistory: true,
              queries: ["blue-orchid validation decision"],
              includeRecentMessages: 2,
            },
            completionCriteria: [
              "demo.txt is changed.",
              "A test passes after the change.",
            ],
            confidence: 0.98,
            ambiguities: [],
            rationale: "The user requested a repository change and verification.",
          }),
        };
      },
      chat: async (input) => {
        decisionInputs.push(input);
        return decisions[decisionIndex++] ?? { type: "FAILED", error: "No TaskFrame decision" };
      },
    };
    const loop = createLoop({
      llmClient,
      onProgress: (event) => progress.push(event),
    });

    const result = await loop.run({
      userGoal: "把 demo.txt 改好并验证",
      taskContract: createTaskFrameBootstrapContract(),
      conversation: [
        { role: "user", content: "recent unrelated question" },
        { role: "assistant", content: "recent unrelated answer" },
      ],
      conversationCorpus: [
        { role: "user", content: "Use blue-orchid validation for demo changes." },
        { role: "assistant", content: "The blue-orchid decision requires a post-change test." },
        ...Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          content: `unrelated conversation ${String(index)}`,
        })),
      ],
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result).toMatchObject({
      success: true,
      taskKind: "AGENT_TASK",
      summary: "TaskFrame changed and verified demo.txt.",
    });
    expect(decisionInputs[0]?.availableTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "web_search", "knowledge_search"]),
    );
    expect(decisionInputs[0]?.context).not.toContain("demo file");
    expect(decisionInputs[0]?.context).not.toContain("Repository tree");
    expect(decisionInputs[0]?.conversation?.map((message) => message.content).join("\n"))
      .toContain("blue-orchid decision");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "understanding",
      source: "MODEL_TASK_FRAME",
      mutationRequirement: "REQUIRED",
    }));
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8"))
      .resolves.toBe("single control chain\n");
  });

  it("fails closed before any action when a required TaskFrame remains invalid after repair", async () => {
    const chat = vi.fn<LlmClient["chat"]>(async () => ({
      type: "FINAL",
      success: true,
      summary: "This decision must never be accepted.",
    }));
    let taskFrameCalls = 0;
    const llmClient: LlmClient = {
      compileTaskFrame: async () => {
        taskFrameCalls += 1;
        return {
          success: true,
          text: taskFrameCalls === 1 ? "not json" : "{\"version\":1}",
        };
      },
      chat,
    };
    const loop = createLoop({ llmClient });

    const result = await loop.run({
      userGoal: "写一个新的贪吃蛇小游戏",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(taskFrameCalls).toBe(2);
    expect(chat).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("TASK_FRAME_UNRESOLVED"),
    });
    await expect(fs.access(path.join(repoPath, "snake.html"))).rejects.toBeDefined();
  });

  it("does not treat a pre-existing artifact as the product of a new create request", async () => {
    await fs.writeFile(path.join(repoPath, "snake.html"), "<title>old snake</title>\n", "utf8");
    const progress: AgentProgressEvent[] = [];
    let decisionIndex = 0;
    let taskFrameCalls = 0;
    const decisions: AgentDecision[] = [
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "snake.html" },
        reason: "Inspect the existing artifact before deciding how to implement the request",
      },
      {
        type: "FINAL",
        success: true,
        summary: "贪吃蛇小游戏已经写好，文件为 snake.html。",
      },
      {
        type: "APPLY_PATCH",
        description: "Replace the old placeholder with the requested game",
        patch: [
          "diff --git a/snake.html b/snake.html",
          "--- a/snake.html",
          "+++ b/snake.html",
          "@@ -1 +1,2 @@",
          "-<title>old snake</title>",
          "+<title>new snake game</title>",
          "+<canvas id=\"game\"></canvas>",
          "",
        ].join("\n"),
      },
      {
        type: "TOOL_CALL",
        toolName: "verify_file",
        input: { path: "snake.html" },
        reason: "Verify the standalone HTML and inline JavaScript syntax",
      },
      {
        type: "FINAL",
        success: true,
        summary: "本轮已更新 snake.html，写入新的贪吃蛇游戏页面。",
      },
    ];
    const llmClient: LlmClient = {
      compileTaskFrame: async () => {
        taskFrameCalls += 1;
        return {
          success: true,
          text: JSON.stringify({
            ...createTestTaskFrame({
              objective: "Create a new snake game in the repository.",
              target: "REPOSITORY",
              effects: {
                repositoryRead: true,
                repositoryWrite: "REQUIRED",
              },
            }),
            conversationEvidence: {
              requiresHistory: false,
              queries: [],
              includeRecentMessages: 1,
            },
          }),
        };
      },
      chat: async () => decisions[decisionIndex++]
        ?? { type: "FAILED", error: "No scripted decision" },
    };
    const loop = createLoop({
      llmClient,
      onProgress: (event) => progress.push(event),
    });

    const result = await loop.run({
      userGoal: "写一个贪吃蛇小游戏",
      taskContract: createTaskFrameBootstrapContract(),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(taskFrameCalls).toBe(1);
    expect(result).toMatchObject({
      success: true,
      summary: expect.stringContaining("本轮已更新"),
    });
    expect(progress).toContainEqual(expect.objectContaining({
      type: "guardrail",
      code: "FINAL_WITHOUT_REPOSITORY_CHANGE",
    }));
    await expect(fs.readFile(path.join(repoPath, "snake.html"), "utf8"))
      .resolves.toContain("<canvas");
  });

  it.each([
    "帮我分析一下这个文件",
    "请读取并分析",
  ])("keeps safe read tools available when the preliminary frame misses a file-analysis request: %s", async (request) => {
    await fs.writeFile(path.join(repoPath, "2048.html"), "<title>2048</title>\n", "utf8");
    const userGoal = `${request} ${path.join(repoPath, "2048.html")}`;
    const taskContract = createTestTaskContract({
      objective: userGoal,
      target: "REPOSITORY",
      effects: { repositoryRead: true },
    });
    const client = new ScriptedLlmClient([
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "2048.html" },
        reason: "Read the user-specified file before analyzing it",
      },
      {
        type: "FINAL",
        success: true,
        summary: "2048.html contains a 2048 page.",
      },
    ]);
    const loop = createLoop({ llmClient: client });

    expect(taskContract).toMatchObject({
      kind: "AGENT_TASK",
      executionStrategy: "ITERATIVE",
      capabilities: {
        repositoryRead: true,
        repositoryWrite: false,
        commandExecution: false,
      },
    });

    const result = await loop.run({
      userGoal,
      taskContract,
      nonInteractive: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.summary).toContain("2048.html");
    expect(client.getTaskFrameCallInputs()).toHaveLength(0);
    expect(client.getCallInputs()).toHaveLength(2);
    expect(client.getCallInputs()[0]?.availableTools.map((tool) => tool.name))
      .toEqual(expect.arrayContaining(["read_file", "list_files", "search_code"]));
  });

  it("keeps the root AgentLoop alive when the provider exhausts its AgentDecision JSON repair attempt", async () => {
    const passScriptPath = path.join(repoPath, "pass-verification.mjs");
    await fs.writeFile(passScriptPath, "process.exit(0);\n", "utf8");
    const progress: AgentProgressEvent[] = [];
    const client = new ScriptedLlmClient([
      {
        type: "APPLY_PATCH",
        description: "Apply the requested change before the protocol failure",
        patch: [
          "diff --git a/demo.txt b/demo.txt",
          "--- a/demo.txt",
          "+++ b/demo.txt",
          "@@ -1 +1 @@",
          "-demo file",
          "+updated demo",
          "",
        ].join("\n"),
      },
      {
        type: "FAILED",
        error: "LLM response did not contain a JSON object",
      },
      {
        type: "RUN_COMMAND",
        executable: process.execPath,
        args: [passScriptPath, "npm test"],
        description: "Verify the preserved patch after protocol recovery",
      },
      {
        type: "FINAL",
        success: true,
        summary: "Updated and verified demo.txt.",
      },
    ]);
    const loop = createLoop({
      llmClient: client,
      onProgress: (event) => progress.push(event),
    });

    const userGoal = "修改 demo.txt 并验证结果";
    const result = await loop.run({
      userGoal,
      taskContract: repositoryContract(userGoal),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result).toMatchObject({
      success: true,
      summary: "Updated and verified demo.txt.",
    });
    expect(client.getCallInputs()).toHaveLength(4);
    expect(client.getCallInputs()[2]?.context).toContain("RECOVERABLE_LLM_PROTOCOL_ERROR");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("updated demo\n");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "guardrail",
      code: "RECOVERABLE_LLM_PROTOCOL_ERROR",
    }));
  });

  it("recovers from a create patch for an existing untracked file and modifies it normally", async () => {
    const targetPath = path.join(repoPath, "2048.html");
    await fs.writeFile(targetPath, "<title>2048</title>\n", "utf8");
    const incorrectCreatePatch = [
      "diff --git a/2048.html b/2048.html",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/2048.html",
      "@@ -0,0 +1 @@",
      "+<title>2048</title>",
      "",
    ].join("\n");
    const client = new ScriptedLlmClient([
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "2048.html", maxLines: 100 },
        reason: "Read the existing game before optimizing it",
      },
      {
        type: "APPLY_PATCH",
        patch: incorrectCreatePatch,
        description: "Incorrectly recreate the untracked file",
      },
      {
        type: "APPLY_PATCH",
        patch: [
          "diff --git a/2048.html b/2048.html",
          "--- a/2048.html",
          "+++ b/2048.html",
          "@@ -1 +1 @@",
          "-<title>2048</title>",
          "+<title>2048 Improved</title>",
          "",
        ].join("\n"),
        description: "Modify the existing workspace file",
      },
      {
        type: "TOOL_CALL",
        toolName: "verify_file",
        input: { path: "2048.html" },
        reason: "Verify the standalone HTML with a compatible parser",
      },
      {
        type: "FINAL",
        success: true,
        summary: "Optimized the existing untracked 2048.html file.",
      },
    ]);
    const userGoal = "优化 2048.html";
    const loop = createLoop({ llmClient: client });

    const result = await loop.run({
      userGoal,
      taskContract: createTestTaskContract({
        objective: userGoal,
        target: "REPOSITORY",
        effects: { repositoryRead: true, repositoryWrite: "REQUIRED" },
        completionCriteria: ["2048.html is modified."],
      }),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("<title>2048 Improved</title>\n");
    expect(client.getCallInputs()[2]?.context).toContain("PATCH_TARGET_ALREADY_EXISTS");
    expect(client.getCallInputs()[2]?.context).toContain("Git tracking is irrelevant");
    expect(client.getCallInputs()[2]?.context).toContain("Filesystem state: EXISTS");
  });

  it("stops a repeated failed patch with the precise filesystem error", async () => {
    await fs.writeFile(path.join(repoPath, "2048.html"), "existing\n", "utf8");
    const incorrectCreatePatch = [
      "diff --git a/2048.html b/2048.html",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/2048.html",
      "@@ -0,0 +1 @@",
      "+replacement",
      "",
    ].join("\n");
    const client = new ScriptedLlmClient([
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "2048.html", maxLines: 100 },
        reason: "Read the existing file",
      },
      { type: "APPLY_PATCH", patch: incorrectCreatePatch, description: "First create attempt" },
      { type: "APPLY_PATCH", patch: incorrectCreatePatch, description: "Renamed duplicate attempt" },
    ]);
    const userGoal = "优化 2048.html";
    const loop = createLoop({ llmClient: client });

    const result = await loop.run({
      userGoal,
      taskContract: createTestTaskContract({
        objective: userGoal,
        target: "REPOSITORY",
        effects: { repositoryRead: true, repositoryWrite: "REQUIRED" },
      }),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("repeated a failed decision");
    expect(result.error).toContain("PATCH_TARGET_ALREADY_EXISTS");
    expect(result.error).not.toContain("failed too many consecutive steps");
    expect(client.getCallInputs()).toHaveLength(3);
  });

  it("recovers from a placeholder patch using a precise no-changes diagnostic", async () => {
    await fs.writeFile(path.join(repoPath, "game.html"), "<title>Old game</title>\n", "utf8");
    const client = new ScriptedLlmClient([
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "game.html" }, reason: "Read the target" },
      {
        type: "APPLY_PATCH",
        description: "placeholder",
        patch: "diff --git a/game.html b/game.html\n--- a/game.html\n+++ b/game.html\n@@ -1 +1 @@\n <title>Old game</title>\n",
      },
      {
        type: "APPLY_PATCH",
        description: "Apply the actual title improvement",
        patch: "diff --git a/game.html b/game.html\n--- a/game.html\n+++ b/game.html\n@@ -1 +1 @@\n-<title>Old game</title>\n+<title>Improved game</title>\n",
      },
      { type: "TOOL_CALL", toolName: "verify_file", input: { path: "game.html" }, reason: "Verify HTML" },
      { type: "FINAL", success: true, summary: "Improved game.html." },
    ]);
    const loop = createLoop({ llmClient: client });
    const userGoal = "优化 game.html";

    const result = await loop.run({
      userGoal,
      taskContract: createTestTaskContract({
        objective: userGoal,
        target: "REPOSITORY",
        effects: { repositoryRead: true, repositoryWrite: "REQUIRED", verification: "SYNTAX" },
      }),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(client.getCallInputs()[2]?.context).toContain("PATCH_NO_CHANGES");
    await expect(fs.readFile(path.join(repoPath, "game.html"), "utf8"))
      .resolves.toBe("<title>Improved game</title>\n");
  });

  it("does not multiply retries after the client reports output-budget exhaustion", async () => {
    const progress: AgentProgressEvent[] = [];
    const client = new ScriptedLlmClient([{
      type: "FAILED",
      error: "LLM_OUTPUT_BUDGET_EXHAUSTED: finish_reason=length before a valid AgentDecision was completed (max_tokens=32768)",
    }]);
    const loop = createLoop({
      llmClient: client,
      onProgress: (event) => progress.push(event),
    });
    const userGoal = "修改 demo.txt";

    const result = await loop.run({
      userGoal,
      taskContract: repositoryContract(userGoal),
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("LLM_OUTPUT_BUDGET_EXHAUSTED");
    expect(client.getCallInputs()).toHaveLength(1);
    expect(progress).not.toContainEqual(expect.objectContaining({
      type: "guardrail",
      code: "RECOVERABLE_LLM_PROTOCOL_ERROR",
    }));
  });

  it("blocks an unchanged duplicate idempotent read and lets the model continue from existing evidence", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const client = new ScriptedLlmClient([
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "demo.txt", startLine: 1, maxLines: 50 },
        reason: "Read the file",
      },
      {
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "demo.txt", startLine: 1, maxLines: 50 },
        reason: "Read the same unchanged range again",
      },
      {
        type: "FINAL",
        success: true,
        summary: "Used the existing read result instead of reading it again.",
      },
    ]);
    const loop = createLoop({ sessionStore, llmClient: client });

    const result = await loop.run({
      userGoal: "读取 demo.txt 并说明内容",
      taskContract: createTestTaskContract({
        objective: "Read demo.txt and explain its contents.",
        target: "REPOSITORY",
        effects: { repositoryRead: true },
      }),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(client.getCallInputs()[2]?.context).toContain("REDUNDANT_IDEMPOTENT_TOOL_CALL");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.filter((record) => record.type === "TOOL_CALL")).toHaveLength(1);
  });

  it("answers a usage follow-up without inheriting or re-inferring a mandatory patch", async () => {
    await fs.writeFile(path.join(repoPath, "claude.ts"), "export const usage = '/exit';\n", "utf8");
    const sessionStore = new SessionStore({ repoPath });
    let decisionCalls = 0;
    const llmClient: LlmClient = {
      chat: async () => {
        decisionCalls += 1;
        return decisionCalls === 1
          ? { type: "TOOL_CALL", toolName: "read_file", input: { path: "claude.ts" } }
          : { type: "FINAL", success: true, summary: "运行该文件并输入 /exit 退出。" };
      },
    };
    const loop = createLoop({ sessionStore, llmClient });

    const result = await loop.run({
      userGoal: "你创建的这个文件，具体使用方法是什么？",
      taskContract: createTestTaskContract({
        objective: "Explain how to use the previously created claude.ts file.",
        target: "REPOSITORY",
        answer: { shape: "EXPLANATION" },
        effects: { repositoryRead: true },
      }),
      conversation: [
        { role: "user", content: "给我写个简易版本的 claude code" },
        { role: "assistant", content: "已创建 claude.ts。" },
      ],
      nonInteractive: true,
    });

    expect(result).toMatchObject({
      success: true,
      summary: "运行该文件并输入 /exit 退出。",
    });
    expect(decisionCalls).toBe(2);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_REPOSITORY_CHANGE")))
      .toBe(false);
  });

  it("semantically adjudicates an unfamiliar mutation-like explanation before rejecting FINAL", async () => {
    await fs.writeFile(path.join(repoPath, "core.ts"), "export const value = 1;\n", "utf8");
    const sessionStore = new SessionStore({ repoPath });
    let semanticCalls = 0;
    const llmClient: LlmClient = {
      compileTaskFrame: async () => {
        semanticCalls += 1;
        return {
          success: true,
          text: JSON.stringify(createTestTaskFrame({
            objective: "Explain how core.ts could be modified without editing it now.",
            target: "REPOSITORY",
            answer: { shape: "EXPLANATION" },
            effects: { repositoryRead: false, repositoryWrite: "NONE" },
            confidence: 0.98,
            rationale: "The user asks for an explanation of how to edit, not for an edit now.",
          })),
        };
      },
      chat: async () => ({
        type: "FINAL",
        success: true,
        summary: "可以在 core.ts 中调整 value 的定义；当前请求只要求说明，因此未改文件。",
      }),
    };
    const loop = createLoop({ sessionStore, llmClient });

    const result = await loop.run({
      userGoal: "请说明如何修改 core.ts",
      nonInteractive: true,
    });

    expect(result).toMatchObject({
      success: true,
      summary: expect.stringContaining("未改文件"),
    });
    expect(semanticCalls).toBe(1);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITHOUT_REPOSITORY_CHANGE")))
      .toBe(false);
  });

  it("allows a conditional fix task to finish without a patch when inspection finds no issue", async () => {
    const llmClient: LlmClient = {
      compileTaskFrame: async () => ({
        success: true,
        text: JSON.stringify(createTestTaskFrame({
          objective: "Inspect demo.txt and repair it only if a defect is found.",
          target: "REPOSITORY",
          effects: {
            repositoryRead: true,
            repositoryWrite: "CONDITIONAL",
          },
          confidence: 0.97,
          rationale: "A patch is requested only if inspection establishes a defect.",
        })),
      }),
      chat: async (input) => input.state.step === 0
        ? { type: "TOOL_CALL", toolName: "read_file", input: { path: "demo.txt" } }
        : { type: "FINAL", success: true, summary: "检查后没有发现需要修改的问题。" },
    };
    const loop = createLoop({ llmClient });

    const result = await loop.run({
      userGoal: "检查 demo.txt，如果发现问题就修复，否则告诉我没有问题",
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.finalDiff).toBe("");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("demo file\n");
  });

  it("upgrades Web research to repository execution when the model selects a patch", async () => {
    const progress: AgentProgressEvent[] = [];
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      eventStore,
      onProgress: (event) => { progress.push(event); },
      llmClient: new ScriptedLlmClient([
        {
          type: "TOOL_CALL",
          toolName: "read_file",
          input: { path: "demo.txt", maxLines: 559, maxTokens: 8_000 },
          reason: "Inspect the current implementation before optimizing it",
        },
        {
          type: "APPLY_PATCH",
          description: "Optimize the file after research",
          patch: [
            "diff --git a/demo.txt b/demo.txt",
            "--- a/demo.txt",
            "+++ b/demo.txt",
            "@@ -1 +1,2 @@",
            " demo file",
            "+optimized",
            "",
          ].join("\n"),
        },
        {
          type: "FINAL",
          success: true,
          summary: "Optimized demo.txt in the same task.",
        },
      ]),
    });

    const initialWebContract = webSearchOnlyContract("能在此基础上进行优化吗");
    const result = await loop.run({
      userGoal: "能在此基础上进行优化吗",
      taskContract: {
        ...initialWebContract,
        // This scenario isolates action-driven capability upgrading. Web
        // evidence preservation is covered by CapabilityNegotiator tests.
        evidence: {
          ...initialWebContract.evidence,
          webSearch: false,
        },
      },
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.taskKind).toBe("AGENT_TASK");
    expect(result.resultMode).toBe("AGENT_LOOP");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8"))
      .resolves.toBe("demo file\noptimized\n");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "capability_upgrade",
      previousKind: "AGENT_TASK",
      kind: "AGENT_TASK",
      action: "APPLY_PATCH",
    }));
    expect(progress.some((event) =>
      event.type === "tool_result" && event.toolName === "read_file" && event.success,
    )).toBe(true);
    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toContain("TASK_CONTRACT_UPGRADED");
    expect(eventTypes(events)).toContain("PATCH_APPLY_FINISHED");
  });

  it("corrects an iterative answer that denies a visible prior assistant claim", async () => {
    const progress: AgentProgressEvent[] = [];
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const userGoal = "你刚才有没有说过会获得星核变身？";
    const taskContract = createTestTaskContract({
      objective: userGoal,
      target: "SESSION",
      conversationEvidence: {
        purpose: "PRIOR_RESPONSE_AUDIT",
        requiresHistory: true,
        queries: ["星核变身"],
      },
    });
    const llmClient: LlmClient = {
      chat: async () => ({
        type: "FINAL",
        success: true,
        summary: "我之前没有说过会获得星核变身，我只是说可以击败守门者。",
      }),
    };
    const loop = createLoop({
      sessionStore,
      eventStore,
      llmClient,
      onProgress: (event) => { progress.push(event); },
    });
    const conversation = [
      { role: "user" as const, content: "第三章有什么能力？" },
      { role: "assistant" as const, content: "击败守门者以后会获得星核变身。" },
    ];

    const result = await loop.run({
      userGoal,
      taskContract,
      conversation,
      conversationTrace: {
        totalMessages: 8,
        selectedMessages: 2,
        estimatedInputTokens: 400,
        estimatedOutputTokens: 80,
        truncated: true,
        focusedOnLatestTurn: false,
        selectionStrategy: "TASK_FRAME_RETRIEVAL",
        matchedAssistantMessages: 1,
        roles: ["user", "assistant"],
      },
      nonInteractive: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.summary).toContain("确实存在");
    expect(result.summary).toContain("撤回未核验部分");
    expect(progress.some((event) =>
      event.type === "guardrail" && event.code === "PRIOR_RESPONSE_DENIAL_CORRECTED",
    )).toBe(true);
    expect(eventTypes(await eventStore.readEvents(result.sessionId)))
      .toContain("PRIOR_RESPONSE_DENIAL_CORRECTED");
  });

  it("corrects model capability claims that contradict the local registry", async () => {
    const progress: AgentProgressEvent[] = [];
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const taskContract = createTestTaskContract({
      objective: "所以这个助手以后也没法碰外网了吗？",
      target: "PRODUCT",
    });
    const llmClient: LlmClient = {
      chat: async () => ({
        type: "FINAL",
        success: true,
        summary: "是的，我不能联网，也无法访问网页。",
      }),
    };
    const loop = createLoop({
      sessionStore,
      eventStore,
      llmClient,
      onProgress: (event) => { progress.push(event); },
    });

    const result = await loop.run({
      userGoal: "所以这个助手以后也没法碰外网了吗？",
      taskContract,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.summary).toContain("支持受控联网研究");
    expect(result.summary).toContain("web_search");
    expect(progress.some((event) => event.type === "guardrail" && event.code === "CAPABILITY_CLAIM_CORRECTED")).toBe(true);
    expect(eventTypes(await eventStore.readEvents(result.sessionId))).toContain("CAPABILITY_CLAIM_CORRECTED");
  });

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
      taskContract: repositoryContract("give demo.txt hello from mini-agent"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(result.finalDiff).toContain("+hello from mini-agent");
    expect(result.diffArtifactId).toMatch(/^[A-Za-z0-9_.-]+$/);
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
      "TASK_DIFF",
      "TASK_SUMMARY",
    ]));
    expect(recordTypes(records)).not.toContain("ASSISTANT_MESSAGE");
    expect(toolNames(records)).toEqual(expect.arrayContaining(["search_code", "read_file", "apply_patch", "git_diff"]));
    expect(typeof records.find((record) => record.type === "USER_MESSAGE")?.payload.runId).toBe("string");
    expect(records.find((record) => record.type === "DIFF_SUMMARY")?.payload.diff).toBeUndefined();
    expect(records.find((record) => record.type === "TASK_SUMMARY")?.payload.finalDiff).toBeUndefined();

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
      "context",
      "llm",
      "decision",
      "plan",
      "tool",
      "tool_result",
      "patch",
      "patch_result",
      "command",
      "command_result",
      "diff",
      "summary",
    ]));
    expect(progress.filter((event) => event.type !== "session").every((event) => (
      typeof event.sequence === "number" && typeof event.runId === "string" && typeof event.step === "number"
    ))).toBe(true);
  });

  it("fails when maxSteps is reached", async () => {
    const eventStore = new EventStore({ repoPath });
    const loop = createLoop({ eventStore });

    const result = await loop.run({
      userGoal: "demo: stop early",
      taskContract: repositoryContract("demo: stop early"),
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
        type: "DELEGATE",
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
      taskContract: repositoryContract("Analyze the agent architecture"),
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

  it("applies a reviewed child patch only after an explicit parent merge decision", async () => {
    const client = new ScriptedLlmClient([
      {
        type: "DELEGATE",
        reason: "Implement and review independently",
        tasks: [
          {
            id: "writer",
            role: "implementation_agent",
            objective: "Update demo.txt",
            focusPaths: ["demo.txt"],
            access: "PROPOSE_CHANGES",
            dependsOn: [],
          },
          {
            id: "reviewer",
            role: "change_reviewer",
            objective: "Review the writer patch",
            focusPaths: ["demo.txt"],
            access: "REVIEW_CHANGES",
            dependsOn: ["writer"],
          },
        ],
      },
      { type: "APPLY_DELEGATED_PATCH", taskId: "writer", description: "Merge reviewed child proposal" },
      {
        type: "RUN_COMMAND",
        executable: "git",
        args: ["diff", "--check"],
        description: "Verify delegated change",
      },
      { type: "FINAL", success: true, summary: "Used a writer and reviewer, merged the proposal, and verified it." },
    ]);
    const coordinator: SubAgentCoordinator = {
      runBatch: async ({ tasks }) => ({
        batchId: "write-review",
        status: "COMPLETED",
        results: [
          {
            taskId: "writer",
            role: "implementation_agent",
            objective: tasks[0]!.objective,
            status: "COMPLETED",
            summary: "Proposed update",
            evidence: [{ path: "demo.txt" }],
            toolsCalled: ["read_file"],
            usage: emptySubAgentUsage(),
            proposedPatch: [
              "diff --git a/demo.txt b/demo.txt",
              "--- a/demo.txt",
              "+++ b/demo.txt",
              "@@ -1 +1,2 @@",
              " demo file",
              "+delegated change",
              "",
            ].join("\n"),
            changedFiles: ["demo.txt"],
          },
          {
            taskId: "reviewer",
            role: "change_reviewer",
            objective: tasks[1]!.objective,
            status: "COMPLETED",
            summary: "APPROVE",
            evidence: [{ path: "demo.txt" }],
            toolsCalled: ["read_file"],
            usage: emptySubAgentUsage(),
            reviewedTaskIds: ["writer"],
          },
        ],
        usage: emptySubAgentUsage(),
        maxParallelAgents: 1,
        durationMs: 20,
      }),
    };
    const loop = createLoop({ llmClient: client, subAgentCoordinator: coordinator });
    const userGoal = "请用两个subagent修改 demo.txt，一个实现，一个review";

    const result = await loop.run({
      userGoal,
      taskContract: repositoryContract(userGoal),
      autoApprove: true,
      nonInteractive: true,
      multiAgent: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8"))
      .resolves.toContain("delegated change");
  });

  it("fails immediately when required writer delegation is exhausted and never falls back to a parent patch", async () => {
    const client = new ScriptedLlmClient([
      {
        type: "DELEGATE",
        reason: "Use the requested writer",
        tasks: [{
          id: "writer",
          role: "implementation_agent",
          objective: "Create delegated.html",
          focusPaths: ["delegated.html"],
          access: "PROPOSE_CHANGES",
          dependsOn: [],
        }],
      },
      {
        type: "APPLY_PATCH",
        description: "Parent fallback must not run",
        patch: [
          "diff --git a/delegated.html b/delegated.html",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/delegated.html",
          "@@ -0,0 +1 @@",
          "+fallback",
          "",
        ].join("\n"),
      },
    ]);
    const coordinator: SubAgentCoordinator = {
      runBatch: async ({ tasks }) => ({
        batchId: "failed-writer",
        status: "FAILED",
        results: [{
          taskId: "writer",
          role: "implementation_agent",
          objective: tasks[0]!.objective,
          status: "FAILED",
          summary: "Invalid JSON in LLM response",
          error: "Invalid JSON in LLM response",
          evidence: [],
          toolsCalled: [],
          usage: emptySubAgentUsage(),
        }],
        usage: emptySubAgentUsage(),
        maxParallelAgents: 1,
        durationMs: 10,
      }),
    };
    const loop = createLoop({ llmClient: client, subAgentCoordinator: coordinator });
    const userGoal = "请用subagent写一个 delegated.html";
    const result = await loop.run({
      userGoal,
      taskContract: requiredDelegationContract(userGoal),
      autoApprove: true,
      nonInteractive: true,
      multiAgent: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true, maxBatchesPerRun: 1 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("REQUIRED_DELEGATION_EXHAUSTED");
    expect(result.error).toContain("Invalid JSON in LLM response");
    await expect(fs.access(path.join(repoPath, "delegated.html"))).rejects.toBeDefined();
    expect(client.getCallInputs()).toHaveLength(1);
  });

  it("interprets an indirect repository request through a model TaskFrame", async () => {
    const decisions: AgentDecision[] = [
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "demo.txt" }, reason: "Inspect the implementation" },
      {
        type: "APPLY_PATCH",
        description: "Correct the implementation",
        patch: [
          "diff --git a/demo.txt b/demo.txt",
          "--- a/demo.txt",
          "+++ b/demo.txt",
          "@@ -1 +1 @@",
          "-demo file",
          "+handled",
          "",
        ].join("\n"),
      },
      { type: "FINAL", success: true, summary: "Updated demo.txt." },
    ];
    let decisionCalls = 0;
    const client: LlmClient = {
      compileTaskFrame: async (input) => {
        expect(input.userGoal).toBe("demo.txt 这个实现看着不太对，你处理一下");
        return {
          success: true,
          text: JSON.stringify(createTestTaskFrame({
            objective: "Correct the named repository file.",
            target: "REPOSITORY",
            effects: {
              repositoryRead: true,
              repositoryWrite: "REQUIRED",
            },
            rationale: "The user asks to correct the named repository file.",
          })),
        };
      },
      chat: async () => decisions[Math.min(decisionCalls++, decisions.length - 1)]!,
    };
    const progress: AgentProgressEvent[] = [];
    const loop = createLoop({ llmClient: client, onProgress: (event) => { progress.push(event); } });

    const result = await loop.run({
      userGoal: "demo.txt 这个实现看着不太对，你处理一下",
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("handled\n");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "understanding",
      source: "MODEL_TASK_FRAME",
      operation: "CHANGE_REPOSITORY",
    }));
  });

  it("does not apply a writer proposal when a required dependent review exhausts its budget", async () => {
    const client = new ScriptedLlmClient([{
      type: "DELEGATE",
      reason: "Use the requested writer and reviewer",
      tasks: [
        {
          id: "writer",
          role: "implementation_agent",
          objective: "Update demo.txt",
          focusPaths: ["demo.txt"],
          access: "PROPOSE_CHANGES",
          dependsOn: [],
        },
        {
          id: "reviewer",
          role: "change_reviewer",
          objective: "Review the proposal",
          focusPaths: ["demo.txt"],
          access: "REVIEW_CHANGES",
          dependsOn: ["writer"],
        },
      ],
    }]);
    const coordinator: SubAgentCoordinator = {
      runBatch: async ({ tasks }) => ({
        batchId: "partial-review",
        status: "PARTIAL",
        results: [
          {
            taskId: "writer",
            role: "implementation_agent",
            objective: tasks[0]!.objective,
            status: "COMPLETED",
            summary: "Writer proposal",
            evidence: [{ path: "demo.txt" }],
            toolsCalled: ["read_file"],
            proposedPatch: [
              "diff --git a/demo.txt b/demo.txt",
              "--- a/demo.txt",
              "+++ b/demo.txt",
              "@@ -1 +1 @@",
              "-seed",
              "+delegated",
              "",
            ].join("\n"),
            changedFiles: ["demo.txt"],
            usage: emptySubAgentUsage(),
          },
          {
            taskId: "reviewer",
            role: "change_reviewer",
            objective: tasks[1]!.objective,
            status: "FAILED",
            summary: "Invalid JSON in LLM response",
            error: "Invalid JSON in LLM response",
            evidence: [],
            toolsCalled: [],
            usage: emptySubAgentUsage(),
          },
        ],
        usage: emptySubAgentUsage(),
        maxParallelAgents: 1,
        durationMs: 10,
      }),
    };
    const loop = createLoop({ llmClient: client, subAgentCoordinator: coordinator });
    const userGoal = "请用两个subagent修改 demo.txt，一个实现，一个review";
    const result = await loop.run({
      userGoal,
      taskContract: requiredDelegationContract(userGoal, true),
      autoApprove: true,
      nonInteractive: true,
      multiAgent: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true, maxBatchesPerRun: 1 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("REQUIRED_DELEGATION_EXHAUSTED");
    expect(result.error).toContain("dependent child review");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("demo file\n");
    expect(client.getCallInputs()).toHaveLength(1);
  });

  it("rejects a delegated patch that conflicts with parent changes after the child baseline", async () => {
    const baselineFingerprint = await fingerprintWorkingTree(repoPath);
    const client = new ScriptedLlmClient([
      {
        type: "DELEGATE",
        reason: "Use the requested writer",
        tasks: [{
          id: "writer",
          role: "implementation_agent",
          objective: "Update demo.txt",
          focusPaths: ["demo.txt"],
          access: "PROPOSE_CHANGES",
          dependsOn: [],
        }],
      },
      { type: "APPLY_DELEGATED_PATCH", taskId: "writer", description: "Merge writer proposal" },
    ]);
    const coordinator: SubAgentCoordinator = {
      runBatch: async ({ tasks }) => {
        await fs.writeFile(path.join(repoPath, "demo.txt"), "parent concurrent change\n", "utf8");
        return {
          batchId: "conflicting-writer",
          status: "COMPLETED",
          results: [{
            taskId: "writer",
            role: "implementation_agent",
            objective: tasks[0]!.objective,
            status: "COMPLETED",
            summary: "Writer proposal",
            evidence: [{ path: "demo.txt" }],
            toolsCalled: ["read_file", "apply_patch"],
            proposedPatch: [
              "diff --git a/demo.txt b/demo.txt",
              "--- a/demo.txt",
              "+++ b/demo.txt",
              "@@ -1 +1 @@",
              "-demo file",
              "+delegated",
              "",
            ].join("\n"),
            changedFiles: ["demo.txt"],
            baselineFingerprint,
            workspaceKind: "GIT_WORKTREE",
            usage: emptySubAgentUsage(),
          }],
          usage: emptySubAgentUsage(),
          maxParallelAgents: 1,
          durationMs: 10,
        };
      },
    };
    const progress: AgentProgressEvent[] = [];
    const loop = createLoop({
      llmClient: client,
      subAgentCoordinator: coordinator,
      onProgress: (event) => { progress.push(event); },
    });
    const userGoal = "请用subagent修改 demo.txt";
    const result = await loop.run({
      userGoal,
      taskContract: repositoryContract(userGoal),
      autoApprove: true,
      nonInteractive: true,
      maxSteps: 3,
      multiAgent: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("DELEGATED_PATCH_CONFLICT");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8"))
      .resolves.toBe("parent concurrent change\n");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "guardrail",
      code: "DELEGATED_PATCH_CONFLICT",
    }));
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
      taskContract: repositoryContract("Create notes.txt containing hello."),
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
      taskContract: createTestTaskContract({
        objective: "Explain the next independent task.",
        target: "DERIVATION",
      }),
      autoApprove: true,
      nonInteractive: true,
    });
    expect(next.success).toBe(true);
    expect(nextClient.getCallInputs()).toHaveLength(1);
    expect(nextClient.getCallInputs()[0]?.context).not.toContain("Recovered after interruption");
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
      taskContract: repositoryContract("simulate command failure"),
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
      taskContract: repositoryContract("verify the current behavior"),
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
      taskContract: repositoryContract("demo: needs patch approval"),
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
      taskContract: repositoryContract("try shell bypass"),
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
      taskContract: repositoryContract("request an unknown tool"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("Tool not found: not_a_tool"))).toBe(true);
  });

  it("returns action-specific guidance when a decision action is sent as a tool call", async () => {
    const client = new ScriptedLlmClient([
      { type: "TOOL_CALL", toolName: "run_command", input: { executable: "npm", args: ["test"] } },
      { type: "FINAL", success: true, summary: "Recovered from the protocol error." },
    ]);
    const loop = createLoop({ llmClient: client });

    const result = await loop.run({
      userGoal: "recover from a malformed action",
      taskContract: repositoryContract("recover from a malformed action"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(client.getCallInputs()[1]?.state.lastError).toContain("DECISION_ACTION_REQUIRED");
    expect(client.getCallInputs()[1]?.state.lastError).toContain("RUN_COMMAND");
  });

  it("records an error when the model sends invalid tool input", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "read_file", input: { path: "demo.txt", maxLines: 0 } },
        { type: "FINAL", success: true, summary: "Recovered from bad tool input." },
      ]),
    });

    const result = await loop.run({
      userGoal: "send invalid tool input",
      taskContract: repositoryContract("send invalid tool input"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("Tool input validation failed"))).toBe(true);
    expect(records.some((record) => JSON.stringify(record.payload).includes("maxLines"))).toBe(true);
  });

  it("blocks an early review final until paged reads cover the complete target", async () => {
    await fs.writeFile(
      path.join(repoPath, "large.ts"),
      Array.from({ length: 650 }, (_, index) => `const l${String(index + 1)}=0;`).join("\n"),
      "utf8",
    );
    const progress: AgentProgressEvent[] = [];
    const client = new ScriptedLlmClient([
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "large.ts", startLine: 1, maxLines: 300 } },
      { type: "FINAL", success: true, summary: "Reviewed the complete file." },
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "large.ts", startLine: 301, maxLines: 300 } },
      { type: "TOOL_CALL", toolName: "read_file", input: { path: "large.ts", startLine: 601, maxLines: 300 } },
      { type: "FINAL", success: true, summary: "Reviewed all 650 lines." },
    ]);
    const loop = createLoop({
      llmClient: client,
      onProgress: (event) => { progress.push(event); },
    });
    const taskContract = createTestTaskContract({
      objective: "完整检查 large.ts",
      target: "REPOSITORY",
      effects: { repositoryRead: true },
      constraints: { readOnly: true, requireCompleteFileRead: true },
    });

    const result = await loop.run({
      userGoal: "完整检查 large.ts",
      taskContract,
      nonInteractive: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.summary).toContain("650");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "guardrail",
      code: "FINAL_WITH_INCOMPLETE_FILE_READ",
    }));
    const reads = progress.filter((event) => event.type === "tool_result" && event.toolName === "read_file");
    expect(reads).toHaveLength(3);
    expect(reads[0]).toMatchObject({ summary: expect.stringContaining("partial 1-300/650") });
    expect(client.getCallInputs()[1]?.context).toContain("Active file chunk:");
    expect(client.getCallInputs()[1]?.context).toContain("l300");
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
      taskContract: createTestTaskContract({
        objective: "Create a TypeScript function.",
        target: "REPOSITORY",
        effects: {
          repositoryWrite: "REQUIRED",
          commandExecution: true,
          verification: "STATIC",
        },
      }),
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
      taskContract: repositoryContract("Update value.mjs to export 2 and verify its syntax."),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "value.mjs"), "utf8")).resolves.toContain("value = 2");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("FINAL_WITH_STALE_VERIFICATION"))).toBe(true);
  });

  it("writes a save-to-file follow-up without relying on a phrase-specific clarification guardrail", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
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
      taskContract: createTestTaskContract({
        objective: "Write the supplied MedianFinder code to a repository file.",
        target: "REPOSITORY",
        effects: {
          repositoryWrite: "REQUIRED",
          commandExecution: true,
          verification: "STATIC",
        },
      }),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "src", "median_finder.ts"), "utf8")).resolves.toContain("MedianFinder");

    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("REDUNDANT_FILE_WRITE_QUESTION"))).toBe(false);
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
      taskContract: createTestTaskContract({
        objective: "Create the design document.",
        target: "REPOSITORY",
        effects: { repositoryWrite: "REQUIRED" },
      }),
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
        {
          type: "FINAL",
          success: true,
          evidenceStatus: "INSUFFICIENT",
          summary: "知识库中没有找到相关证据，无法回答。",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: "请用知识库查一下上传策略",
      taskContract: createTestTaskContract({
        objective: "Answer the upload-policy question from indexed knowledge.",
        target: "REPOSITORY",
        effects: { knowledgeEvidence: true },
      }),
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
      "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2F93.184.216.34%2Fresearch\">Research Result</a>",
      "<a class=\"result__snippet\">A current public web result.</a>",
      "</div>",
      "</body></html>",
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "PLAN", message: "Search the web for the user's research question." },
        { type: "TOOL_CALL", toolName: "web_search", input: { query: "research topic", maxResults: 3 } },
        { type: "TOOL_CALL", toolName: "fetch_url", input: { url: "https://93.184.216.34/research" } },
        {
          type: "FINAL",
          success: true,
          summary: "Found a relevant public web result: https://93.184.216.34/research",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: "联网搜索一下 research topic",
      autoApprove: true,
      nonInteractive: true,
      taskContract: webSearchOnlyContract("联网搜索一下 research topic"),
    });

    const records = await sessionStore.readRecords(result.sessionId);
    expect(
      result.success,
      [result.error, JSON.stringify(records.filter((record) =>
        record.type === "TOOL_CALL" || record.type === "TOOL_RESULT",
      ))].join("\n"),
    ).toBe(true);
    expect(toolNames(records)).toContain("web_search");
    expect(records.some((record) => JSON.stringify(record.payload).includes("Research Result"))).toBe(true);
  });

  it("finishes with an explicit limitation when web search transport is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const sessionStore = new SessionStore({ repoPath });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "web_search", input: { query: "公开事实", maxResults: 3 } },
        {
          type: "FINAL",
          success: true,
          evidenceStatus: "INSUFFICIENT",
          summary: "本轮 web_search 连接失败，当前来源不足，无法核验这项公开事实。",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: "联网核实这项公开事实",
      autoApprove: true,
      nonInteractive: true,
      taskContract: webSearchOnlyContract("联网核实这项公开事实"),
    });

    expect(result.success, result.error).toBe(true);
    expect(result.summary).toContain("来源不足");
    expect(result.summary).not.toContain("failed too many consecutive steps");
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("WEB_SEARCH_FAILED"))).toBe(true);
  });

  it("deterministically returns a limitation final instead of exhausting steps when strict Web evidence is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      "<html><body>",
      "<div class=\"result\">",
      "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2Fexample.com%2Fresearch\">Research Result</a>",
      "<a class=\"result__snippet\">One available public source.</a>",
      "</div>",
      "</body></html>",
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
    const progress: AgentProgressEvent[] = [];
    const baseContract = createTestTaskContract({
      objective: "Corroborate a public fact.",
      target: "WORLD",
      effects: { webEvidence: true },
      webEvidencePolicy: {
        profile: "CORROBORATED",
        basis: "USER_REQUESTED_CORROBORATION",
      },
    });
    const loop = createLoop({
      onProgress: (event) => { progress.push(event); },
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "web_search", input: { query: "public fact" } },
        {
          type: "FINAL",
          success: true,
          summary: "The available result suggests a possible answer.",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: "请用多个来源核实这项公开事实",
      taskContract: {
        ...baseContract,
        capabilities: { ...baseContract.capabilities, webAccess: true },
        maxSteps: 3,
      },
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain("The available result suggests a possible answer.");
    expect(result.summary).toContain("现有证据不足");
    expect(result.summary).toContain("https://example.com/research");
    expect(result.summary).not.toContain("reaching max steps");
    expect(progress).toContainEqual(expect.objectContaining({
      type: "guardrail",
      code: "WEB_LIMITATION_FINAL_APPLIED",
    }));
  });

  it("rejects a strengthened ranking query and retries with the user's original scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      "<html><body>",
      "<div class=\"result\">",
      "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2F93.184.216.34%2Fsongs\">Representative songs</a>",
      "<a class=\"result__snippet\">Several well-known songs.</a>",
      "</div>",
      "</body></html>",
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
    const sessionStore = new SessionStore({ repoPath });
    const progress: AgentProgressEvent[] = [];
    const goal = "联网查 Kanye West 有哪些知名的歌曲";
    const loop = createLoop({
      sessionStore,
      onProgress: (event) => { progress.push(event); },
      llmClient: new ScriptedLlmClient([
        { type: "TOOL_CALL", toolName: "web_search", input: { query: "Kanye West most famous songs" } },
        { type: "TOOL_CALL", toolName: "web_search", input: { query: "Kanye West famous notable songs" } },
        { type: "TOOL_CALL", toolName: "fetch_url", input: { url: "https://93.184.216.34/songs" } },
        {
          type: "FINAL",
          success: true,
          summary: "已按“知名歌曲”而非排名范围检索，代表性结果包括：Stronger、Gold Digger、Heartless。来源：https://93.184.216.34/songs",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: goal,
      autoApprove: true,
      nonInteractive: true,
      taskContract: webSearchOnlyContract(goal),
    });

    expect(result.success, result.error).toBe(true);
    expect(progress.some((event) =>
      event.type === "guardrail" && event.code === "WEB_QUERY_SCOPE_STRENGTHENED",
    )).toBe(true);
    const records = await sessionStore.readRecords(result.sessionId);
    const searchInputs = records
      .filter((record) => record.type === "TOOL_CALL" && record.payload.toolName === "web_search")
      .map((record) => JSON.stringify(record.payload));
    expect(searchInputs).toHaveLength(1);
    expect(searchInputs[0]).toContain("famous notable songs");
    expect(searchInputs[0]).not.toContain("most famous");
  });

  it("blocks a duplicate successful web call within the same run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      "<html><body>",
      "<div class=\"result\">",
      "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2F93.184.216.34%2Fresearch\">Research Result</a>",
      "<a class=\"result__snippet\">A current public web result.</a>",
      "</div>",
      "</body></html>",
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
    const sessionStore = new SessionStore({ repoPath });
    const progress: AgentProgressEvent[] = [];
    const duplicate = { type: "TOOL_CALL", toolName: "web_search", input: { query: "same query", maxResults: 3 } } as const;
    const loop = createLoop({
      sessionStore,
      onProgress: (event) => { progress.push(event); },
      llmClient: new ScriptedLlmClient([
        duplicate,
        duplicate,
        { type: "TOOL_CALL", toolName: "fetch_url", input: { url: "https://93.184.216.34/research" } },
        {
          type: "FINAL",
          success: true,
          summary: "Used the first successful search result: https://93.184.216.34/research",
        },
      ]),
    });

    const result = await loop.run({
      userGoal: "search the web once",
      autoApprove: true,
      nonInteractive: true,
      taskContract: webSearchOnlyContract("search the web once"),
    });

    expect(result.success, result.error).toBe(true);
    const records = await sessionStore.readRecords(result.sessionId);
    expect(toolNames(records).filter((name) => name === "web_search")).toHaveLength(1);
    expect(records.some((record) => JSON.stringify(record.payload).includes("REDUNDANT_WEB_TOOL_CALL"))).toBe(true);
    expect(progress.some((event) => event.type === "guardrail" && event.code === "REDUNDANT_WEB_TOOL_CALL")).toBe(true);
    const contextEvents = progress.filter((event) => event.type === "context");
    expect(contextEvents.every((event) => event.trace.sessionMemory?.totalRecords === 0)).toBe(true);
    expect(contextEvents.every((event) =>
      event.trace.sessionMemory?.excludedCurrentRunRecords === 0,
    )).toBe(true);
  });

  it("blocks repository writes at runtime for a read-only investigation contract", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const forbiddenPath = path.join(repoPath, "forbidden.txt");
    const taskContract = createTestTaskContract({
      objective: "review demo.txt",
      target: "REPOSITORY",
      effects: { repositoryRead: true },
      constraints: { readOnly: true },
    });
    const loop = createLoop({
      sessionStore,
      llmClient: new ScriptedLlmClient([
        {
          type: "APPLY_PATCH",
          description: "must be blocked by the task contract",
          patch: [
            "diff --git a/forbidden.txt b/forbidden.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/forbidden.txt",
            "@@ -0,0 +1 @@",
            "+blocked",
            "",
          ].join("\n"),
        },
        { type: "FAILED", error: "Stopped after the rejected write." },
      ]),
    });

    const result = await loop.run({
      userGoal: "review demo.txt",
      taskContract,
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    await expect(fs.access(forbiddenPath)).rejects.toBeDefined();
    const records = await sessionStore.readRecords(result.sessionId);
    expect(records.some((record) => JSON.stringify(record.payload).includes("CAPABILITY_ADAPTATION_DENIED"))).toBe(true);
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
      taskContract: repositoryContract("keep failing"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("failed too many consecutive steps");
    const events = await eventStore.readEvents(result.sessionId);
    expect(eventTypes(events)).toContain("TASK_FAILED");
  });

  it("reports repeated guardrail failures separately from model or tool failures", async () => {
    const loop = createLoop({
      llmClient: new ScriptedLlmClient([
        { type: "FINAL", success: true, summary: "Unverified answer one." },
        { type: "FINAL", success: true, summary: "Unverified answer two." },
        { type: "FINAL", success: true, summary: "Unverified answer three." },
        { type: "FINAL", success: true, summary: "Unverified answer four." },
      ]),
    });

    const result = await loop.run({
      userGoal: "OpenAI 最新的模型是什么？",
      taskContract: webSearchOnlyContract("OpenAI 最新的模型是什么？"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not satisfy guardrail FINAL_WITHOUT_WEB_SEARCH");
    expect(result.error).not.toContain("failed too many consecutive steps");
  });

  it("stops an alternating guardrail cycle when neither branch adds completion evidence", async () => {
    const client = new ScriptedLlmClient([
      { type: "FINAL", success: true, summary: "Still unverified." },
      { type: "TOOL_CALL", toolName: "run_command", input: { executable: "node", args: ["--check", "page.html"] } },
      { type: "FINAL", success: true, summary: "Still unverified again." },
      { type: "TOOL_CALL", toolName: "run_command", input: { executable: "node", args: ["--check", "page.html"] } },
      { type: "FINAL", success: true, summary: "Still unverified a third time." },
      { type: "TOOL_CALL", toolName: "run_command", input: { executable: "node", args: ["--check", "page.html"] } },
      { type: "FINAL", success: true, summary: "Still unverified a fourth time." },
    ]);
    const loop = createLoop({ llmClient: client });

    const result = await loop.run({
      userGoal: "OpenAI 最新的模型是什么？",
      taskContract: webSearchOnlyContract("OpenAI 最新的模型是什么？"),
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("recurring guardrail cycle");
    expect(result.error).not.toContain("reaching max steps");
    expect(client.getCallInputs().length).toBeLessThanOrEqual(7);
  });

  it("removes tools and constrains the model when the Web final-synthesis reserve starts", async () => {
    const client = new ScriptedLlmClient([
      { type: "PLAN", message: "Inspect the task." },
      { type: "PLAN", message: "Prepare the research plan." },
      { type: "FAILED", error: "Insufficient evidence in the reserved synthesis step." },
    ]);
    const loop = createLoop({ llmClient: client });

    await loop.run({
      userGoal: "Claude 最新的模型是什么？",
      taskContract: webSearchOnlyContract("Claude 最新的模型是什么？"),
      maxSteps: 4,
      autoApprove: true,
      nonInteractive: true,
    });

    const synthesisInput = client.getCallInputs()[2];
    expect(synthesisInput?.decisionConstraint).toBe("FINAL_ONLY");
    expect(synthesisInput?.availableTools).toEqual([]);
    expect(synthesisInput?.context).toContain("Phase: SYNTHESIZE");
    expect(synthesisInput?.context).toContain("Required next action: LIMITATION_FINAL");
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
      taskContract: createTestTaskContract({
        objective: "Plan how to modify demo.txt and test the change.",
        target: "REPOSITORY",
        effects: {
          repositoryRead: true,
          repositoryWrite: "REQUIRED",
          verification: "TEST",
        },
        operatingMode: "PLAN",
      }),
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

function webSearchOnlyContract(userGoal: string) {
  const contract = createTestTaskContract({
    objective: userGoal,
    target: "WORLD",
    effects: { webEvidence: true },
  });
  return {
    ...contract,
    evidence: {
      ...contract.evidence,
      fetchedWebSourceCount: 0,
      independentWebDomainCount: 0,
      webCitation: false,
    },
  };
}

function repositoryContract(userGoal: string) {
  return createTestTaskContract({
    objective: userGoal,
    target: "REPOSITORY",
    effects: {
      repositoryRead: false,
      repositoryWrite: "CONDITIONAL",
      delegation: true,
    },
    collaboration: { requirement: "OPTIONAL" },
    multiAgentAvailable: true,
  });
}

function requiredDelegationContract(userGoal: string, review = false) {
  return createTestTaskContract({
    objective: userGoal,
    target: "REPOSITORY",
    effects: {
      repositoryWrite: "CONDITIONAL",
      delegation: true,
    },
    collaboration: {
      requirement: "REQUIRED",
      changeProposal: true,
      review,
      requestedAgents: review ? 2 : 1,
    },
    multiAgentAvailable: true,
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

function emptySubAgentUsage() {
  return {
    steps: 1,
    llmCalls: 1,
    toolCalls: 1,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    usageAvailable: false,
  };
}
