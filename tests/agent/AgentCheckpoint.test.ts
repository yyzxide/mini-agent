import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import {
  checkpointToPayload,
  createAgentCheckpoint,
  parseAgentCheckpoint,
  recoverLatestAgentCheckpoint,
} from "../../src/agent/AgentCheckpoint.js";
import type { SessionRecord } from "../../src/session/SessionTypes.js";

describe("AgentCheckpoint", () => {
  it("persists compact working state and effects without raw patch or command output", () => {
    const state = new AgentState({ sessionId: "session", runId: "run-1", repoPath: "/repo", userGoal: "modify src/app.ts" });
    state.addPatchResult({
      description: "Update app",
      patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old secret body\n+new secret body\n",
      result: { success: true },
    });
    state.addCommandResult({
      command: "npm test",
      cwd: "/repo",
      exitCode: 0,
      stdout: "very large output that must not be checkpointed",
      stderr: "",
      durationMs: 10,
      success: true,
      timedOut: false,
      truncated: false,
    });
    state.incrementStep();

    const checkpoint = createAgentCheckpoint({ state, inFlightAction: "tool:git_diff" });
    const serialized = JSON.stringify(checkpoint);
    expect(checkpoint).toMatchObject({
      version: 1,
      runId: "run-1",
      completedSteps: 1,
      effects: {
        successfulPatch: true,
        verificationAttemptedAfterPatch: true,
        verificationAfterPatch: true,
        latestVerification: { command: "npm test", success: true },
        latestTest: { command: "npm test", success: true },
      },
      workingSet: { modifiedFiles: ["src/app.ts"] },
    });
    expect(serialized).not.toContain("old secret body");
    expect(serialized).not.toContain("very large output");
    expect(parseAgentCheckpoint(checkpointToPayload(checkpoint))).toEqual(checkpoint);
  });

  it("recovers only the latest active checkpoint and isolates completed tasks", () => {
    const active = checkpointRecord("1", { status: "RUNNING" });
    expect(recoverLatestAgentCheckpoint([active])?.runId).toBe("run-1");
    expect(recoverLatestAgentCheckpoint([active, summaryRecord("2")])).toBeUndefined();
    expect(recoverLatestAgentCheckpoint([checkpointRecord("3", { status: "FINISHED" })])).toBeUndefined();
  });

  it("persists compact file coverage without copying source chunks", () => {
    const state = new AgentState({
      sessionId: "session",
      runId: "read-run",
      repoPath: "/repo",
      userGoal: "完整读取 src/large.ts",
    });
    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/large.ts", startLine: 1 },
      result: {
        success: true,
        data: {
          path: "src/large.ts",
          startLine: 1,
          endLine: 300,
          totalLines: 800,
          content: "private source body must not enter checkpoint",
          hasMore: true,
          nextStartLine: 301,
          sourceVersion: "1000:2000",
        },
      },
    });

    const checkpoint = createAgentCheckpoint({ state });
    expect(checkpoint.effects.fileReadCoverage).toEqual([expect.objectContaining({
      path: "src/large.ts",
      ranges: [{ startLine: 1, endLine: 300 }],
      complete: false,
      nextStartLine: 301,
    })]);
    expect(JSON.stringify(checkpoint)).not.toContain("private source body");
    expect(parseAgentCheckpoint(checkpointToPayload(checkpoint))).toEqual(checkpoint);
  });

  it("invalidates recovered coverage when a durable file change follows the checkpoint", () => {
    const state = new AgentState({
      sessionId: "session",
      runId: "read-run",
      repoPath: "/repo",
      userGoal: "完整读取并修改 src/large.ts",
    });
    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/large.ts" },
      result: {
        success: true,
        data: {
          path: "src/large.ts",
          startLine: 1,
          endLine: 800,
          totalLines: 800,
          content: "source",
          sourceVersion: "old",
        },
      },
    });
    const active: SessionRecord = {
      id: "1",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:00.000Z",
      type: "AGENT_CHECKPOINT",
      payload: checkpointToPayload(createAgentCheckpoint({ state, inFlightAction: "patch:update" })),
    };
    const changed: SessionRecord = {
      id: "2",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:01.000Z",
      type: "FILE_CHANGE",
      payload: { files: [{ path: "src/large.ts", changeType: "MODIFIED" }] },
    };

    expect(recoverLatestAgentCheckpoint([active, changed])?.effects.fileReadCoverage).toEqual([]);
  });

  it("reconciles durable side-effect records written after an in-flight checkpoint", () => {
    const active = checkpointRecord("1", { status: "RUNNING", inFlightAction: "patch:Update app", successfulPatch: false });
    const fileChange: SessionRecord = {
      id: "2",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:01.000Z",
      type: "FILE_CHANGE",
      payload: { files: ["src/recovered.ts"], diff: "large diff is not copied" },
    };
    const command: SessionRecord = {
      id: "3",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:02.000Z",
      type: "COMMAND_RESULT",
      payload: { command: "npm test", success: true, exitCode: 0, stdout: "large output" },
    };

    expect(recoverLatestAgentCheckpoint([active, fileChange, command])).toMatchObject({
      effects: {
        successfulPatch: true,
        verificationAttemptedAfterPatch: true,
        verificationAfterPatch: true,
        latestVerification: { command: "npm test", success: true, exitCode: 0 },
        latestTest: { command: "npm test", success: true, exitCode: 0 },
      },
      workingSet: {
        modifiedFiles: expect.arrayContaining(["src/recovered.ts"]),
        verificationStatus: ["PASS: npm test (exit 0)"],
      },
    });
    expect(recoverLatestAgentCheckpoint([active, fileChange, command])?.inFlightAction).toBeUndefined();
  });

  it("does not turn a persisted non-verification command into test evidence after recovery", () => {
    const active = checkpointRecord("1", { status: "RUNNING", successfulPatch: true });
    const spoofed: SessionRecord = {
      id: "2",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:01.000Z",
      type: "COMMAND_RESULT",
      payload: {
        command: "echo npm test",
        success: true,
        exitCode: 0,
        verification: {
          level: "NONE",
          category: "none",
          repositoryWide: false,
          scopePaths: [],
        },
      },
    };

    const recovered = recoverLatestAgentCheckpoint([active, spoofed]);
    expect(recovered?.effects.latestVerification).toBeUndefined();
    expect(recovered?.effects.latestTest).toBeUndefined();
    expect(recovered?.effects.verificationAfterPatch).not.toBe(true);
  });

  it("invalidates recovered verification when a later durable file change is observed", () => {
    const active = checkpointRecord("1", { status: "RUNNING", successfulPatch: true });
    const command: SessionRecord = {
      id: "2",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:01.000Z",
      type: "COMMAND_RESULT",
      payload: { command: "npm test", success: true, exitCode: 0 },
    };
    const fileChange: SessionRecord = {
      id: "3",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:02.000Z",
      type: "FILE_CHANGE",
      payload: { files: ["src/later.ts"] },
    };

    expect(recoverLatestAgentCheckpoint([active, command, fileChange])).toMatchObject({
      effects: {
        successfulPatch: true,
        verificationAttemptedAfterPatch: false,
        verificationAfterPatch: false,
        latestVerification: { command: "npm test", success: true },
      },
    });
  });

  it("reconciles a completed sub-agent batch after an in-flight checkpoint", () => {
    const active = checkpointRecord("1", { status: "RUNNING", inFlightAction: "delegation:inspect" });
    const batch: SessionRecord = {
      id: "2",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:01.000Z",
      type: "SUBAGENT_BATCH_RESULT",
      payload: {
        batchId: "batch-1",
        status: "COMPLETED",
        results: [{
          taskId: "architecture",
          role: "repository_analyst",
          objective: "Inspect architecture",
          status: "COMPLETED",
          summary: "Found the parent loop.",
          evidence: [{ path: "src/agent/AgentLoop.ts" }],
          toolsCalled: ["read_file"],
          usage: childUsage(),
        }],
        usage: childUsage(),
        maxParallelAgents: 1,
        durationMs: 10,
      },
    };

    const recovered = recoverLatestAgentCheckpoint([active, batch]);
    expect(recovered?.collaboration?.batches[0]).toMatchObject({
      batchId: "batch-1",
      results: [{ taskId: "architecture", status: "COMPLETED" }],
    });
    expect(recovered?.inFlightAction).toBeUndefined();
  });

  it("ignores malformed legacy checkpoint records", () => {
    const malformed: SessionRecord = {
      id: "bad",
      sessionId: "session",
      timestamp: "2026-07-16T00:00:00.000Z",
      type: "AGENT_CHECKPOINT",
      payload: { version: 99, status: "RUNNING" },
    };
    expect(recoverLatestAgentCheckpoint([malformed])).toBeUndefined();
    expect(recoverLatestAgentCheckpoint([checkpointRecord("old", { status: "RUNNING" }), malformed])).toBeUndefined();
  });
});

function checkpointRecord(id: string, overrides: {
  status: "RUNNING" | "FINISHED";
  inFlightAction?: string;
  successfulPatch?: boolean;
}): SessionRecord {
  return {
    id,
    sessionId: "session",
    timestamp: "2026-07-16T00:00:00.000Z",
    type: "AGENT_CHECKPOINT",
    payload: {
      version: 1,
      runId: "run-1",
      userGoal: "change src/app.ts",
      operatingMode: "EXECUTE",
      status: overrides.status,
      completedSteps: 1,
      totalSteps: 1,
      workingSet: {
        constraints: [],
        relevantFiles: ["src/app.ts"],
        modifiedFiles: ["src/app.ts"],
        completedActions: ["patch:applied"],
        unresolvedQuestions: [],
        latestFailures: [],
        verificationStatus: [],
      },
      effects: { successfulPatch: overrides.successfulPatch ?? true },
      ...(overrides.inFlightAction ? { inFlightAction: overrides.inFlightAction } : {}),
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
  };
}

function summaryRecord(id: string): SessionRecord {
  return {
    id,
    sessionId: "session",
    timestamp: "2026-07-16T00:00:01.000Z",
    type: "TASK_SUMMARY",
    payload: { summary: "done", success: true, mode: "AGENT_LOOP" },
  };
}

function childUsage() {
  return {
    steps: 1,
    llmCalls: 2,
    toolCalls: 1,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedPromptTokens: 2,
    reasoningTokens: 1,
    usageAvailable: true,
  };
}
