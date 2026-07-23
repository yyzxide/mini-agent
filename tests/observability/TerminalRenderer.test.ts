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
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
      },
    });
    renderer.render({ type: "tool", toolName: "read_file", input: { path: "src/index.ts" } });
    renderer.render({ type: "tool_result", toolName: "read_file", success: true, durationMs: 18, summary: "src/index.ts" });
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
    expect(text).toContain("[tool] read_file · path=src/index.ts");
    expect(text).toContain("367 tests passed");
    expect(text).toContain("[usage] calls=1");
    expect(text).toContain("[summary] Done.");
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
