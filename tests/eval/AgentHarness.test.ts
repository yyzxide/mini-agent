import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/eval/AgentHarness.js";
import { DEFAULT_MULTI_AGENT_POLICY, type SubAgentCoordinator } from "../../src/agent/SubAgentTypes.js";

const createdRepos: string[] = [];

afterEach(async () => {
  for (const repoPath of createdRepos.splice(0)) {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

describe("AgentHarness", () => {
  it("runs a scripted repository-editing scenario end to end", async () => {
    const harness = new AgentHarness();
    const result = await harness.runScenario({
      name: "append demo line",
      userGoal: "append hello to demo.txt",
      files: {
        "demo.txt": "demo\n",
      },
      decisions: [
        {
          type: "APPLY_PATCH",
          description: "Append hello to demo.txt",
          patch: [
            "diff --git a/demo.txt b/demo.txt",
            "--- a/demo.txt",
            "+++ b/demo.txt",
            "@@ -1 +1,2 @@",
            " demo",
            "+hello from harness",
            "",
          ].join("\n"),
        },
        {
          type: "TOOL_CALL",
          toolName: "git_diff",
          input: {},
        },
        {
          type: "FINAL",
          success: true,
          summary: "Appended hello from harness.",
        },
      ],
      expected: {
        success: true,
        toolsCalled: ["git_diff"],
        maxSteps: 4,
        maxLlmCalls: 4,
        diffContains: ["+hello from harness"],
        filesContain: {
          "demo.txt": "hello from harness",
        },
      },
    });
    createdRepos.push(result.repoPath);

    expect(result.run.success).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.metrics.toolCalls).toContain("git_diff");
    expect(result.llmCalls).toBeGreaterThanOrEqual(3);
  });

  it("aggregates suite metrics and failure categories", async () => {
    const harness = new AgentHarness();
    const suite = await harness.runSuite([
      {
        name: "successful answer",
        userGoal: "finish",
        decisions: [{ type: "FINAL", success: true, summary: "done" }],
        expected: { success: true, maxSteps: 1 },
      },
      {
        name: "model failure",
        userGoal: "fail",
        decisions: [{ type: "FAILED", error: "LLM provider unavailable" }],
        expected: { success: true },
      },
    ]);
    createdRepos.push(...suite.scenarios.map((scenario) => scenario.repoPath));

    expect(suite.total).toBe(2);
    expect(suite.passed).toBe(1);
    expect(suite.successRate).toBe(0.5);
    expect(suite.failuresByCategory.EXPECTATION).toBe(1);
  });

  it("includes delegated child calls in cost metrics", async () => {
    const coordinator: SubAgentCoordinator = {
      runBatch: async ({ tasks }) => ({
        batchId: "bench-batch",
        status: "COMPLETED",
        results: tasks.map((task) => ({
          taskId: task.id,
          role: task.role,
          objective: task.objective,
          status: "COMPLETED",
          summary: `Evidence for ${task.id}`,
          evidence: [{ path: "src" }],
          toolsCalled: ["list_files"],
          usage: usage(1),
        })),
        usage: usage(tasks.length),
        maxParallelAgents: tasks.length,
        durationMs: 10,
      }),
    };
    const result = await new AgentHarness().runScenario({
      name: "parallel repository analysis",
      userGoal: "Analyze repository architecture",
      decisions: [
        {
          type: "DELEGATE_READONLY",
          reason: "Inspect architecture and risks",
          tasks: [
            { id: "architecture", role: "repository_analyst", objective: "Map modules", focusPaths: ["src"] },
            { id: "risks", role: "risk_reviewer", objective: "Find risks", focusPaths: ["src"] },
          ],
        },
        { type: "FINAL", success: true, summary: "Analysis complete." },
      ],
      expected: { success: true, maxLlmCalls: 4, toolsCalled: ["list_files"] },
    }, {
      subAgentCoordinator: coordinator,
      multiAgent: { ...DEFAULT_MULTI_AGENT_POLICY, enabled: true },
    });
    createdRepos.push(result.repoPath);

    expect(result.passed).toBe(true);
    expect(result.metrics.llmCalls).toBe(4);
    expect(result.metrics.toolCalls).toContain("list_files");
    expect(result.run).toMatchObject({ delegationBatches: 1, subAgents: 2 });
  });
});

function usage(llmCalls: number) {
  return {
    steps: llmCalls,
    llmCalls,
    toolCalls: llmCalls,
    promptTokens: llmCalls * 10,
    completionTokens: llmCalls * 5,
    totalTokens: llmCalls * 15,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    usageAvailable: true,
  };
}
