import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { MockLlmClient } from "../../src/llm/MockLlmClient.js";

describe("MockLlmClient", () => {
  it("generates the deterministic demo flow", async () => {
    const client = new MockLlmClient();
    const state = new AgentState({
      sessionId: "test-session",
      repoPath: "/repo",
      userGoal: "demo: add hello",
    });

    await expectDecisionType(client, state, "PLAN");
    state.incrementStep();
    await expectDecision(client, state, { type: "TOOL_CALL", toolName: "search_code" });
    state.incrementStep();
    await expectDecision(client, state, { type: "TOOL_CALL", toolName: "read_file" });
    state.incrementStep();

    const patchDecision = await client.chat({
      userGoal: state.userGoal,
      context: "",
      state: state.toSnapshot(),
      availableTools: [],
    });

    expect(patchDecision.type).toBe("APPLY_PATCH");
    if (patchDecision.type === "APPLY_PATCH") {
      expect(patchDecision.patch).toContain("hello from mini-agent");
    }

    state.incrementStep();
    await expectDecision(client, state, { type: "RUN_COMMAND", command: "echo test passed" });
    state.incrementStep();
    await expectDecision(client, state, { type: "TOOL_CALL", toolName: "git_diff" });
    state.incrementStep();
    await expectDecisionType(client, state, "FINAL");
  });

  it("uses the default repository inspection flow for unknown tasks", async () => {
    const client = new MockLlmClient();
    const state = new AgentState({
      sessionId: "test-session",
      repoPath: "/repo",
      userGoal: "inspect this repo",
    });

    await expectDecisionType(client, state, "PLAN");
    state.incrementStep();
    await expectDecision(client, state, { type: "TOOL_CALL", toolName: "git_status" });
    state.incrementStep();
    await expectDecision(client, state, { type: "TOOL_CALL", toolName: "list_files" });
  });
});

async function expectDecisionType(
  client: MockLlmClient,
  state: AgentState,
  type: string,
): Promise<void> {
  const decision = await client.chat({
    userGoal: state.userGoal,
    context: "",
    state: state.toSnapshot(),
    availableTools: [],
  });

  expect(decision.type).toBe(type);
}

async function expectDecision(
  client: MockLlmClient,
  state: AgentState,
  expected: { type: string; toolName?: string; command?: string },
): Promise<void> {
  const decision = await client.chat({
    userGoal: state.userGoal,
    context: "",
    state: state.toSnapshot(),
    availableTools: [],
  });

  expect(decision).toMatchObject(expected);
}
