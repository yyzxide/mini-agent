import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadonlySubAgentCoordinator } from "../../src/agent/ReadonlySubAgentCoordinator.js";
import { DEFAULT_MULTI_AGENT_POLICY, type SubAgentIdentity } from "../../src/agent/SubAgentTypes.js";
import type { AgentDecision } from "../../src/agent/AgentDecision.js";
import type { LlmClient } from "../../src/llm/LlmClient.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-children-"));
  await fs.writeFile(path.join(repoPath, "example.ts"), "export const answer = 42;\n", "utf8");
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("ReadonlySubAgentCoordinator", () => {
  it("runs independent children concurrently while preserving task order", async () => {
    let active = 0;
    let observedConcurrency = 0;
    const coordinator = new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (identity) => {
        let calls = 0;
        return {
          chat: async (): Promise<AgentDecision> => {
            calls += 1;
            if (calls === 1) {
              active += 1;
              observedConcurrency = Math.max(observedConcurrency, active);
              await new Promise((resolve) => setTimeout(resolve, identity.taskId === "slow" ? 30 : 10));
              active -= 1;
              return { type: "TOOL_CALL", toolName: "read_file", input: { path: "example.ts" } };
            }
            return { type: "FINAL", success: true, summary: `report:${identity.taskId}` };
          },
        };
      },
    });

    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Inspect the repository",
      tasks: [task("slow", "repository_analyst"), task("fast", "risk_reviewer")],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true, maxConcurrency: 2 },
    });

    expect(observedConcurrency).toBe(2);
    expect(batch.maxParallelAgents).toBe(2);
    expect(batch.results.map((result) => result.taskId)).toEqual(["slow", "fast"]);
    expect(batch.status).toBe("COMPLETED");
  });

  it("rejects mutation decisions from children", async () => {
    const coordinator = coordinatorWithDecision({
      type: "APPLY_PATCH",
      description: "Forbidden",
      patch: "diff --git a/a b/a\n",
    });
    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Inspect",
      tasks: [task("one", "repository_analyst"), task("two", "risk_reviewer")],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });

    expect(batch.status).toBe("FAILED");
    expect(batch.results.every((result) => result.status === "PROTOCOL_VIOLATION")).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "example.ts"), "utf8")).resolves.toBe("export const answer = 42;\n");
  });

  it("accepts a validated new-file proposal without forcing an unrelated repository read", async () => {
    const coordinator = coordinatorWithDecision({
      type: "APPLY_PATCH",
      description: "Create standalone game",
      patch: [
        "diff --git a/game.html b/game.html",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/game.html",
        "@@ -0,0 +1 @@",
        "+<main>2048</main>",
        "",
      ].join("\n"),
    });
    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Create a standalone game",
      tasks: [{
        id: "writer",
        role: "implementation_agent",
        objective: "Create game.html",
        focusPaths: ["game.html"],
        access: "PROPOSE_CHANGES",
        dependsOn: [],
      }],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });

    expect(batch.status).toBe("COMPLETED");
    expect(batch.results[0]?.proposedPatch).toContain("new file mode");
    await expect(fs.access(path.join(repoPath, "game.html"))).rejects.toBeDefined();
  });

  it("recovers a bounded child protocol failure instead of aborting immediately", async () => {
    let calls = 0;
    const progress: string[] = [];
    const coordinator = new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (): LlmClient => ({
        chat: async () => {
          calls += 1;
          if (calls === 1) return { type: "FAILED", error: "Invalid JSON in LLM response" };
          if (calls === 2) {
            return {
              type: "APPLY_PATCH",
              description: "Recovered proposal",
              patch: [
                "diff --git a/recovered.txt b/recovered.txt",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/recovered.txt",
                "@@ -0,0 +1 @@",
                "+recovered",
                "",
              ].join("\n"),
            };
          }
          return { type: "FINAL", success: true, summary: "Recovered implementation verified." };
        },
      }),
    });
    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Create a file",
      tasks: [{
        id: "writer",
        role: "implementation_agent",
        objective: "Create recovered.txt",
        focusPaths: ["recovered.txt"],
        access: "PROPOSE_CHANGES",
        dependsOn: [],
      }],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
      onProgress: (event) => { progress.push(event.phase); },
    });

    expect(batch.status).toBe("COMPLETED");
    expect(calls).toBe(3);
    expect(progress).toContain("recovery");
  });

  it("rejects unsupported reports without repository evidence", async () => {
    const coordinator = coordinatorWithDecision({ type: "FINAL", success: true, summary: "Invented report" });
    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Inspect",
      tasks: [task("one", "repository_analyst"), task("two", "risk_reviewer")],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });

    expect(batch.status).toBe("FAILED");
    expect(batch.results.every((result) => result.summary.includes("without successful repository tool evidence"))).toBe(true);
  });

  it("enforces a shared LLM-call budget across concurrent children", async () => {
    const coordinator = new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (): LlmClient => ({
        chat: async () => ({ type: "TOOL_CALL", toolName: "read_file", input: { path: "example.ts" } }),
      }),
    });
    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Inspect",
      tasks: [task("one", "repository_analyst"), task("two", "risk_reviewer")],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true, maxChildLlmCalls: 2 },
    });

    expect(batch.status).toBe("FAILED");
    expect(batch.usage.llmCalls).toBe(2);
    expect(batch.results.every((result) => result.status === "BUDGET_EXHAUSTED")).toBe(true);
  });

  it("returns an isolated writer patch and lets a dependent child review it", async () => {
    const calls = new Map<string, number>();
    const progress: string[] = [];
    const coordinator = new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (identity): LlmClient => ({
        chat: async () => {
          const call = (calls.get(identity.taskId) ?? 0) + 1;
          calls.set(identity.taskId, call);
          if (call === 1) {
            return { type: "TOOL_CALL", toolName: "read_file", input: { path: "example.ts" } };
          }
          if (identity.taskId === "writer") {
            if (call > 2) {
              return { type: "FINAL", success: true, summary: "Implemented in isolated worktree." };
            }
            return {
              type: "APPLY_PATCH",
              description: "Update answer",
              patch: [
                "diff --git a/example.ts b/example.ts",
                "--- a/example.ts",
                "+++ b/example.ts",
                "@@ -1 +1 @@",
                "-export const answer = 42;",
                "+export const answer = 43;",
                "",
              ].join("\n"),
            };
          }
          return { type: "FINAL", success: true, summary: "APPROVE: change matches the assignment." };
        },
      }),
    });

    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Change the answer and review it",
      tasks: [
        {
          id: "writer",
          role: "implementation_agent",
          objective: "Implement the change",
          focusPaths: ["example.ts"],
          access: "PROPOSE_CHANGES",
          dependsOn: [],
        },
        {
          id: "reviewer",
          role: "change_reviewer",
          objective: "Review the writer patch",
          focusPaths: ["example.ts"],
          access: "REVIEW_CHANGES",
          dependsOn: ["writer"],
        },
      ],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
      onProgress: (event) => {
        progress.push(`${event.taskId}:${event.phase}${"toolName" in event ? `:${event.toolName}` : ""}`);
      },
    });

    expect(batch.status).toBe("COMPLETED");
    expect(batch.maxParallelAgents).toBe(1);
    expect(batch.results[0]?.proposedPatch).toContain("+export const answer = 43;");
    expect(batch.results[1]?.reviewedTaskIds).toEqual(["writer"]);
    expect(progress).toEqual(expect.arrayContaining([
      "writer:task_started",
      "writer:tool_started:read_file",
      "writer:tool_finished:read_file",
      "writer:task_finished",
      "reviewer:task_started",
      "reviewer:task_finished",
    ]));
    await expect(fs.readFile(path.join(repoPath, "example.ts"), "utf8"))
      .resolves.toBe("export const answer = 42;\n");
  });

  it("lets a writer test its isolated changes before returning a proposal", async () => {
    let calls = 0;
    const progress: string[] = [];
    const coordinator = new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (): LlmClient => ({
        chat: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              type: "APPLY_PATCH",
              description: "Create verified module",
              patch: [
                "diff --git a/verified.mjs b/verified.mjs",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/verified.mjs",
                "@@ -0,0 +1 @@",
                "+export const verified = true;",
                "",
              ].join("\n"),
            };
          }
          if (calls === 2) {
            return {
              type: "RUN_COMMAND",
              executable: process.execPath,
              args: ["--check", "verified.mjs"],
              description: "Check generated JavaScript syntax",
            };
          }
          return { type: "FINAL", success: true, summary: "Created and syntax-checked the module." };
        },
      }),
    });
    const batch = await coordinator.runBatch({
      parentRunId: "parent",
      originalGoal: "Create a verified module",
      tasks: [{
        id: "writer",
        role: "implementation_agent",
        objective: "Create and verify verified.mjs",
        focusPaths: ["verified.mjs"],
        access: "PROPOSE_CHANGES",
        dependsOn: [],
      }],
      policy: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
      onProgress: (event) => { progress.push(event.phase); },
    });

    expect(batch.status).toBe("COMPLETED");
    expect(batch.results[0]?.verification).toEqual([
      expect.objectContaining({ success: true, exitCode: 0 }),
    ]);
    expect(batch.results[0]?.proposedPatch).toContain("verified.mjs");
    expect(progress).toEqual(expect.arrayContaining([
      "worktree_started",
      "patch_applied",
      "command_started",
      "command_finished",
    ]));
    await expect(fs.access(path.join(repoPath, "verified.mjs"))).rejects.toBeDefined();
  });

  function coordinatorWithDecision(decision: AgentDecision): ReadonlySubAgentCoordinator {
    return new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (identity: SubAgentIdentity): LlmClient => {
        let calls = 0;
        return {
          chat: async () => {
            calls += 1;
            if (identity.role === "implementation_agent" && decision.type === "APPLY_PATCH" && calls > 1) {
              return { type: "FINAL", success: true, summary: decision.description };
            }
            return decision;
          },
        };
      },
    });
  }
});

function task(id: string, role: "repository_analyst" | "risk_reviewer") {
  return { id, role, objective: `Inspect ${id}`, focusPaths: ["example.ts"] };
}
