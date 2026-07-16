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

  function coordinatorWithDecision(decision: AgentDecision): ReadonlySubAgentCoordinator {
    return new ReadonlySubAgentCoordinator({
      repoPath,
      createLlmClient: (_identity: SubAgentIdentity): LlmClient => ({ chat: async () => decision }),
    });
  }
});

function task(id: string, role: "repository_analyst" | "risk_reviewer") {
  return { id, role, objective: `Inspect ${id}`, focusPaths: ["example.ts"] };
}
