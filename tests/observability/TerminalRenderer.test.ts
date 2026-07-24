import { describe, expect, it } from "vitest";
import { createDefaultAgentTaskContract } from "../../src/agent/AgentTaskContract.js";
import type { ContextTrace } from "../../src/context/ContextTypes.js";
import { TerminalRenderer } from "../../src/observability/TerminalRenderer.js";

describe("TerminalRenderer", () => {
  it("strips terminal control sequences from untrusted output", () => {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      contract: createDefaultAgentTaskContract(),
      color: false,
      write: (text) => output.push(text),
    });
    renderer.render({ type: "command_output", stream: "stdout", chunk: "\u001B]52;c;payload\u0007safe\u001B[2J" });
    renderer.render({ type: "summary", summary: "\u001B[31manswer\u001B[0m", success: true });
    expect(output.join("")).toContain("safe");
    expect(output.join("")).toContain("answer");
    expect(output.join("")).not.toContain("\u001B");
  });
  it("renders a readable runtime timeline with context, cache, tool, command, and token details", () => {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      contract: createDefaultAgentTaskContract(),
      verbosity: "trace",
      color: false,
      write: (text) => { output.push(text); },
    });

    renderer.render({ type: "session", sessionId: "session-1" });
    renderer.render({ type: "follow_up", intent: "LOCATION", source: "FILE_CHANGE", files: ["demo_app.html"], llmSkipped: true });
    renderer.render({
      type: "conversation",
      trace: {
        totalMessages: 8,
        selectedMessages: 2,
        estimatedInputTokens: 1200,
        estimatedOutputTokens: 240,
        truncated: false,
        focusedOnLatestTurn: true,
        selectionStrategy: "LATEST_REFERENT",
        matchedAssistantMessages: 0,
        roles: ["user", "assistant"],
      },
    });
    renderer.render({ type: "context", trace: contextTrace() });
    renderer.render({ type: "cache", cache: "embedding", memoryHits: 1, diskHits: 2, misses: 1, writes: 1, coalescedRequests: 0 });
    renderer.render({ type: "llm", phase: "started", mode: "agent_decision" });
    renderer.render({
      type: "llm",
      phase: "finished",
      mode: "agent_decision",
      calls: 1,
      durationMs: 1250,
      usage: {
        usageAvailable: true,
        promptTokens: 1000,
        completionTokens: 200,
        reasoningTokens: 50,
        reasoningContentAvailable: true,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
      },
    });
    renderer.render({
      type: "decision",
      decisionType: "TOOL_CALL",
      message: "Inspect the target before editing → read_file",
    });
    renderer.render({ type: "tool", toolName: "read_file", input: { path: "src/index.ts" } });
    renderer.render({ type: "tool_result", toolName: "read_file", success: true, durationMs: 18, summary: "src/index.ts" });
    renderer.render({
      type: "agent_task",
      phase: "task_started",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      dependsOn: [],
    });
    renderer.render({
      type: "agent_task",
      phase: "worktree_started",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      workspaceKind: "GIT_WORKTREE",
      baselineFingerprint: "abcdef1234567890",
    });
    renderer.render({
      type: "agent_task",
      phase: "thinking",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      step: 1,
    });
    renderer.render({
      type: "agent_task",
      phase: "decision",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      step: 1,
      decisionType: "TOOL_CALL",
      message: "Inspect the existing file → read_file",
    });
    renderer.render({
      type: "agent_task",
      phase: "patch_applied",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      changedFiles: ["src/index.ts"],
    });
    renderer.render({
      type: "agent_task",
      phase: "command_finished",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      command: "npm test",
      success: true,
      exitCode: 0,
    });
    renderer.render({
      type: "agent_task",
      phase: "recovery",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      error: "Invalid JSON",
      action: "Retry with shorter JSON",
    });
    renderer.render({
      type: "agent_task",
      phase: "tool_finished",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      toolName: "read_file",
      success: true,
    });
    renderer.render({
      type: "agent_task",
      phase: "task_finished",
      taskId: "writer",
      role: "implementation_agent",
      access: "PROPOSE_CHANGES",
      status: "COMPLETED",
      changedFiles: ["src/index.ts"],
      toolsCalled: ["read_file"],
    });
    renderer.render({ type: "command", command: "npm test" });
    renderer.render({ type: "command_output", stream: "stdout", chunk: "367 tests passed\n" });
    renderer.render({ type: "command_result", command: "npm test", success: true, exitCode: 0, durationMs: 1600, timedOut: false, truncated: false });
    renderer.render({ type: "summary", success: true, summary: "Done." });

    const text = output.join("");
    expect(text).toContain("[session] session-1");
    expect(text).toContain("[follow-up] artifact location · source=FILE_CHANGE");
    expect(text).toContain("demo_app.html · LLM skipped");
    expect(text).toContain("[conversation] 2/8 messages · ~240 tokens · prioritized latest exchange");
    expect(text).toContain("[context] · selected=600/7.50k tokens");
    expect(text).toContain("[memory:session]");
    expect(text).toContain("strategy=structured-salience-v2");
    expect(text).toContain("abc123:pinned (explicit user constraint)");
    expect(text).toContain("[cache:embedding]");
    expect(text).toContain("[thinking]");
    expect(text).toContain("prompt-cache-read=800");
    expect(text).toContain("prompt-cache-write=100");
    expect(text).toContain("[reasoning] 50 token(s) reported · private reasoning field available");
    expect(text).toContain("raw chain-of-thought is not displayed");
    expect(text).toContain("structured [decision] lines are the auditable action rationale");
    expect(text).toContain("[decision:TOOL_CALL] Inspect the target before editing → read_file");
    expect(text).toContain("[tool] read_file · path=src/index.ts");
    expect(text).toContain("error=Invalid JSON");
    expect(text).toContain("recovery=Retry with shorter JSON");
    expect(text).toContain("[agent:writer] task started · implementation_agent · PROPOSE_CHANGES");
    expect(text).toContain("workspace=git_worktree · baseline=abcdef123456");
    expect(text).toContain("[agent:writer] thinking step=1");
    expect(text).toContain("[agent:writer] decision:TOOL_CALL");
    expect(text).toContain("Inspect the existing file → read_file");
    expect(text).toContain("isolated files=src/index.ts");
    expect(text).toContain("command=npm test · exit=0");
    expect(text).toContain("tools=read_file");
    expect(text).toContain("367 tests passed");
    expect(text).toContain("[usage] calls=1");
    expect(text).toContain("[answer]\nDone.");
  });

  it("shows when conversation evidence was selected for a prior-response audit", () => {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      contract: createDefaultAgentTaskContract(),
      color: false,
      write: (text) => { output.push(text); },
    });

    renderer.render({
      type: "conversation",
      trace: {
        totalMessages: 24,
        selectedMessages: 8,
        estimatedInputTokens: 3200,
        estimatedOutputTokens: 1100,
        truncated: true,
        focusedOnLatestTurn: false,
        selectionStrategy: "PRIOR_RESPONSE_AUDIT",
        matchedAssistantMessages: 2,
        roles: ["user", "assistant"],
      },
    });

    expect(output.join("")).toContain(
      "prior-response audit · matched 2 prior assistant message(s) · history limited",
    );
  });

  it("shows redacted decision payloads only in trace mode", () => {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      contract: createDefaultAgentTaskContract(),
      verbosity: "trace",
      color: false,
      write: (text) => { output.push(text); },
    });

    renderer.render({
      type: "decision",
      decisionType: "TOOL_CALL",
      message: "Calling tool fetch_url",
      decision: {
        type: "TOOL_CALL",
        toolName: "fetch_url",
        input: { url: "https://example.com", apiKey: "should-not-leak" },
      },
    });

    const text = output.join("");
    expect(text).toContain("[decision:TOOL_CALL]");
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("should-not-leak");
  });

  it("hides the standalone reasoning notice in normal mode", () => {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      contract: createDefaultAgentTaskContract(),
      color: false,
      write: (text) => { output.push(text); },
    });

    renderer.render({
      type: "llm",
      phase: "finished",
      mode: "agent_decision",
      calls: 1,
      usage: {
        usageAvailable: true,
        promptTokens: 100,
        completionTokens: 20,
        reasoningTokens: 10,
        reasoningContentAvailable: true,
      },
    });

    const text = output.join("");
    expect(text).toContain("reasoning=10");
    expect(text).not.toContain("[reasoning]");
    expect(text).not.toContain("chain-of-thought");
  });

  it("keeps the verbose reasoning notice concise", () => {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      contract: createDefaultAgentTaskContract(),
      verbosity: "verbose",
      color: false,
      write: (text) => { output.push(text); },
    });

    renderer.render({
      type: "llm",
      phase: "finished",
      mode: "agent_decision",
      calls: 1,
      usage: {
        usageAvailable: true,
        reasoningTokens: 10,
        reasoningContentAvailable: true,
      },
    });

    const text = output.join("");
    expect(text).toContain("[reasoning] 10 token(s) reported · private reasoning field available");
    expect(text).not.toContain("chain-of-thought");
  });
});

function contextTrace(): ContextTrace {
  return {
    version: 2,
    phase: "DISCOVERY",
    maxChars: 30_000,
    maxTokens: 7500,
    totalChars: 2400,
    totalEstimatedTokens: 600,
    sections: [
      {
        id: "task",
        title: "Task",
        priority: 100,
        required: true,
        stable: true,
        selected: true,
        truncated: false,
        estimatedTokens: 800,
        includedTokens: 500,
        includedChars: 2000,
        reason: "Task context",
      },
      {
        id: "tree",
        title: "Tree",
        priority: 50,
        required: false,
        stable: true,
        selected: false,
        truncated: false,
        estimatedTokens: 400,
        includedTokens: 0,
        includedChars: 0,
        reason: "Repository tree; skipped because higher-priority context consumed the budget",
      },
    ],
    sessionMemory: {
      totalRecords: 40,
      selectedRecords: 12,
      estimatedInputTokens: 3200,
      estimatedOutputTokens: 900,
      compacted: true,
      strategy: "structured-salience-v2",
      candidateRecords: 16,
      droppedRecords: 4,
      clippedRecords: 2,
      pinnedRecords: 3,
      selections: [
        {
          sourceId: "abc123",
          bucket: "PINNED",
          reason: "explicit user constraint",
          clipped: false,
          estimatedTokens: 20,
        },
      ],
    },
    embeddingCache: {
      memoryHits: 1,
      diskHits: 2,
      misses: 1,
      writes: 1,
      coalescedRequests: 0,
    },
  };
}
