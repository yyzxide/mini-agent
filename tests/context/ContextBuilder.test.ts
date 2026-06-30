import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { ContextBuilder } from "../../src/context/ContextBuilder.js";
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
});
