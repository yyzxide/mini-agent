import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
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
    });
    state.addToolResult({
      toolName: "git_status",
      input: {},
      result: {
        success: true,
        data: { status: " M README.md" },
      },
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 10_000 }).build(state);

    expect(context).toContain("User task:");
    expect(context).toContain("inspect repository");
    expect(context).toContain("Runtime context:");
    expect(context).toContain("Current local date:");
    expect(context).toContain("Repository state summary:");
    expect(context).toContain("package manager:");
    expect(context).toContain("Git status:");
    expect(context).toContain("Tree summary:");
    expect(context).toContain("file README.md");
    expect(context).toContain("README summary:");
    expect(context).toContain("Context builder readme.");
    expect(context).toContain("Build files:");
    expect(context).toContain("package.json");
    expect(context).toContain("New file placement guidance:");
    expect(context).toContain("Suggested target paths:");
    expect(context).toContain("Recent tool results:");
    expect(context.length).toBeLessThanOrEqual(10_000);
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
    });

    const context = await new ContextBuilder({ repoPath, maxChars: 10_000 }).build(state);

    expect(context).toContain("Conversation memory:");
    expect(context).toContain("[user] 第一轮我们讨论了 session 记忆");
    expect(context).toContain("[assistant] 我会在后续轮次引用这段上下文");
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
    });
    state.setLastError("last test failure");

    const context = await new ContextBuilder({ repoPath, maxChars: 900 }).build(state);

    expect(context).toContain("Task and step:");
    expect(context).toContain("User task:");
    expect(context).toContain("Diagnostics:");
    expect(context).toContain("Last error:");
    expect(context).toContain("Current diff:");
    expect(context.length).toBeLessThanOrEqual(900);
  });
});
