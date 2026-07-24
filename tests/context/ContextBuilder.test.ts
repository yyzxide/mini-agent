import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { buildAgentTaskContract } from "../../src/agent/TaskContractBuilder.js";
import { routeTask } from "../../src/agent/TaskRouter.js";
import { ContextBuilder } from "../../src/context/ContextBuilder.js";
import { LongTermMemoryStore } from "../../src/memory/LongTermMemoryStore.js";
import { SessionStore } from "../../src/session/SessionStore.js";

const execFileAsync = promisify(execFile);

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-context-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "README.md"), "# Demo\n\nContext builder readme.\n", "utf8");
  await fs.writeFile(path.join(repoPath, "package.json"), "{\n  \"name\": \"demo\"\n}\n", "utf8");
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const demo = true;\n", "utf8");
  await execFileAsync("git", ["add", "README.md", "package.json"], { cwd: repoPath });
  await fs.appendFile(path.join(repoPath, "README.md"), "\nchanged\n", "utf8");
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("ContextBuilder", () => {
  it("builds a bounded repository context for the agent", async () => {
    const state = new AgentState({
      sessionId: "test-session",
      repoPath,
      userGoal: "inspect repository",
      taskContract: contractFor("inspect repository"),
    });
    state.addToolResult({
      toolName: "git_status",
      input: {},
      result: {
        success: true,
        data: { status: " M README.md" },
      },
    });

    const builder = new ContextBuilder({ repoPath, maxChars: 10_000 });
    const context = await builder.build(state);

    expect(context).toContain("User task:");
    expect(context).toContain("inspect repository");
    expect(context).toContain("Repository state summary:");
    expect(context).toContain("package manager:");
    expect(context).toContain("Git status:");
    expect(context).toContain("Tree summary:");
    expect(context).toContain("file README.md");
    expect(context).toContain("README evidence:");
    expect(context).toContain("Context builder readme.");
    expect(context).toContain("Build-file evidence:");
    expect(context).toContain("package.json");
    expect(context).toContain("Task completion contract:");
    expect(context).toContain("Relevant tool evidence:");
    expect(context.length).toBeLessThanOrEqual(10_000);
    expect(builder.getLastTrace()).toMatchObject({ version: 2, phase: "DISCOVERY" });
  });

  it("injects recent session records into the agent context", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const session = await sessionStore.createSession({ title: "memory test" });
    await sessionStore.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "第一轮我们讨论了 session 记忆" },
    });
    await sessionStore.appendRecord(session.sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: "我会在后续轮次引用这段上下文" },
    });

    const state = new AgentState({
      sessionId: session.sessionId,
      repoPath,
      userGoal: "你还记得刚才聊了什么吗",
      taskContract: contractFor("你还记得刚才聊了什么吗"),
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 10_000 }).build(state);

    expect(context).toContain("Conversation memory:");
    expect(context).toContain("[user] 第一轮我们讨论了 session 记忆");
    expect(context).toContain("[assistant] 我会在后续轮次引用这段上下文");
  });

  it("injects deterministic Web research progress for temporal claims", async () => {
    const userGoal = "Claude 最新的模型是什么？";
    const state = new AgentState({
      sessionId: "web-progress",
      repoPath,
      userGoal,
      taskContract: buildAgentTaskContract({
        userGoal,
        route: { intent: "WEB_ANSWER", reason: "test" },
      }),
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 10_000 }).build(state);

    expect(context).toContain("Web research progress:");
    expect(context).toContain("Phase: DISCOVER");
    expect(context).toContain("Search views: 0 / 2");
    expect(context).toContain("Required next action: WEB_SEARCH");
    expect(context).toContain("Remaining decisions: 14");
  });

  it("injects retrieved long-term memory into the agent context", async () => {
    const sessionStore = new SessionStore({ repoPath });
    const oldSession = await sessionStore.createSession({ title: "old coding task" });
    await sessionStore.appendRecord(oldSession.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "帮我写贪吃蛇小游戏" },
    });
    await sessionStore.appendRecord(oldSession.sessionId, {
      type: "TASK_SUMMARY",
      payload: {
        summary: "已创建 demo_app.html，里面是一个浏览器可直接打开的贪吃蛇小游戏。",
        success: true,
        mode: "AGENT_LOOP",
        finalDiff: "+++ b/demo_app.html\n@@ -0,0 +1,10 @@",
      },
    });
    await new LongTermMemoryStore({ repoPath }).indexSession(sessionStore, oldSession.sessionId);

    const currentSession = await sessionStore.createSession({ title: "current task" });
    const state = new AgentState({
      sessionId: currentSession.sessionId,
      repoPath,
      userGoal: "之前那个贪吃蛇游戏怎么运行",
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 12_000 }).build(state);

    expect(context).toContain("Long-term retrieved memory:");
    expect(context).toContain("demo_app.html");
    expect(context).toContain("贪吃蛇");
  });

  it("does not mix historical task memory into explicit document knowledge-base queries", async () => {
    await new LongTermMemoryStore({ repoPath }).remember({
      title: "上传策略",
      text: "旧任务错误地声称分片上传不需要校验。",
    });
    const session = await new SessionStore({ repoPath }).createSession({ title: "knowledge query" });
    const state = new AgentState({
      sessionId: session.sessionId,
      repoPath,
      userGoal: "根据已索引知识库回答上传策略是什么",
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 12_000 }).build(state);

    expect(context).not.toContain("Long-term retrieved memory:");
    expect(context).not.toContain("旧任务错误地声称");
  });

  it("selects matching repository skills into bounded context", async () => {
    const skillPath = path.join(repoPath, "skills", "testing", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, [
      "---",
      "name: testing",
      "description: Run Vitest regression tests",
      "triggers: vitest, regression",
      "---",
      "",
      "Run targeted Vitest tests before the full suite.",
    ].join("\n"), "utf8");
    const session = await new SessionStore({ repoPath }).createSession({ title: "skill context" });
    const state = new AgentState({ sessionId: session.sessionId, repoPath, userGoal: "run vitest regression" });

    const context = await new ContextBuilder({ repoPath, maxChars: 12_000 }).build(state);
    expect(context).toContain("Selected skills:");
    expect(context).toContain("Skill: testing");
    expect(context).toContain("Run targeted Vitest tests");
  });

  it("keeps task diagnostics and diff under tight context budgets", async () => {
    const state = new AgentState({
      sessionId: "tight-budget-session",
      repoPath,
      userGoal: "fix the README regression",
      taskContract: contractFor("fix the README regression"),
    });
    state.setLastError("last test failure");

    const context = await new ContextBuilder({ repoPath, maxChars: 900 }).build(state);

    expect(context).toContain("Task:");
    expect(context).toContain("User task:");
    expect(context).toContain("Active diagnostics:");
    expect(context).toContain("Last error:");
    expect(context).toContain("Current diff:");
    expect(context.length).toBeLessThanOrEqual(900);
  });

  it("drops README and repository discovery context after target-file evidence is available", async () => {
    const state = new AgentState({
      sessionId: "implementation-session",
      repoPath,
      userGoal: "修复 src/index.ts 的布尔值，但不要修改公开 API",
      taskContract: contractFor("修复 src/index.ts 的布尔值，但不要修改公开 API"),
    });
    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/index.ts" },
      result: {
        success: true,
        data: {
          path: "src/index.ts",
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          content: "export const demo = true;",
        },
      },
    });

    const builder = new ContextBuilder({ repoPath, maxChars: 8_000 });
    const context = await builder.build(state);
    const trace = builder.getLastTrace();

    expect(context).toContain("Phase: IMPLEMENTATION");
    expect(context).toContain("不要修改公开 API");
    expect(context).toContain("export const demo = true;");
    expect(context).not.toContain("README evidence:");
    expect(context).not.toContain("Tree summary:");
    expect(context).not.toContain("Repository state summary:");
    expect(trace?.sections.find((section) => section.id === "readme")?.selected).toBe(false);
    expect(trace?.sections.find((section) => section.id === "tree")?.selected).toBe(false);
  });

  it("keeps the latest file chunk directly visible and reports coverage separately", async () => {
    const state = new AgentState({
      sessionId: "complete-read-session",
      repoPath,
      userGoal: "完整读取 src/index.ts",
      taskContract: buildAgentTaskContract({
        userGoal: "完整读取 src/index.ts",
        route: { intent: "AGENT_LOOP", reason: "test" },
      }),
    });
    const source = "const firstChunkMarker = true;\nconst secondLine = true;";
    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/index.ts", startLine: 1 },
      result: {
        success: true,
        data: {
          path: "src/index.ts",
          startLine: 1,
          endLine: 2,
          totalLines: 4,
          content: source,
          hasMore: true,
          nextStartLine: 3,
          estimatedTokens: 20,
          sourceVersion: "v1",
        },
      },
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 20_000, maxTokens: 5_000 }).build(state);

    expect(context).toContain("Active file chunk:");
    expect(context).toContain(source);
    expect(context).toContain("File read coverage:");
    expect(context).toContain("partial; next unread line 3");
    expect(context.match(/firstChunkMarker/g)).toHaveLength(1);
  });

  it("injects runtime information only for time-sensitive tasks", async () => {
    const ordinary = new AgentState({
      sessionId: "ordinary-session",
      repoPath,
      userGoal: "修复 src/index.ts",
    });
    const temporal = new AgentState({
      sessionId: "temporal-session",
      repoPath,
      userGoal: "检查今天生成的构建报告",
    });

    await expect(new ContextBuilder({ repoPath }).build(ordinary)).resolves.not.toContain("Runtime context:");
    await expect(new ContextBuilder({ repoPath }).build(temporal)).resolves.toContain("Runtime context:");
  });
});

function contractFor(userGoal: string) {
  return buildAgentTaskContract({ userGoal, route: routeTask(userGoal) });
}
