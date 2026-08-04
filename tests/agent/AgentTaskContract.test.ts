import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import {
  createDefaultAgentTaskContract,
  selectToolsForTaskContract,
} from "../../src/agent/AgentTaskContract.js";
import { validateAgentDecisionGuardrails } from "../../src/agent/TaskGuardrails.js";
import type { ToolSpec } from "../../src/llm/LlmClient.js";
import { createTestTaskContract } from "../helpers/TaskFrameContract.js";

describe("AgentTaskContract", () => {
  it("defaults to one iterative AGENT_TASK with safe repository reads only", () => {
    expect(createDefaultAgentTaskContract()).toMatchObject({
      kind: "AGENT_TASK",
      executionStrategy: "ITERATIVE",
      capabilities: {
        repositoryRead: true,
        repositoryWrite: false,
        commandExecution: false,
        webAccess: false,
      },
    });
  });

  it("keeps requested effects composable without changing task kind", () => {
    const contract = createTestTaskContract({
      objective: "Research evidence and update the repository.",
      target: "MIXED",
      effects: {
        repositoryRead: true,
        repositoryWrite: "REQUIRED",
        webEvidence: true,
        commandExecution: true,
        verification: "TEST",
      },
    });

    expect(contract).toMatchObject({
      kind: "AGENT_TASK",
      evidence: { repositoryRead: true, webSearch: true, webCitation: true },
      taskFrame: {
        effects: {
          repositoryWrite: "REQUIRED",
          webEvidence: true,
          commandExecution: true,
        },
      },
    });
  });

  it("filters model-visible tools using current exact grants", () => {
    const tools: ToolSpec[] = [
      spec("read_file", "local"),
      spec("apply_patch", "local"),
      spec("web_search", "local"),
      spec("server__read", "mcp"),
      spec("server__other", "mcp"),
    ];
    const contract = {
      ...createTestTaskContract({ objective: "Use one MCP tool." }),
      capabilities: {
        ...createDefaultAgentTaskContract().capabilities,
        mcpAccess: true,
      },
      mcpToolGrants: ["server__read"],
    };

    expect(selectToolsForTaskContract(tools, contract).map((tool) => tool.name))
      .toEqual(["read_file", "server__read"]);
  });

  it("enforces repository evidence selected by TaskFrame", () => {
    const contract = createTestTaskContract({
      objective: "Analyze the repository.",
      target: "REPOSITORY",
      effects: { repositoryRead: true },
    });
    const state = stateFor(contract, "Analyze the repository.");

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "This is a repository analysis.",
    })).toMatchObject({ code: "FINAL_WITHOUT_REPOSITORY_EVIDENCE" });

    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/agent/AgentLoop.ts" },
      result: {
        success: true,
        data: {
          path: "src/agent/AgentLoop.ts",
          startLine: 1,
          endLine: 10,
          totalLines: 10,
          content: "code",
        },
      },
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "Analysis is grounded in src/agent/AgentLoop.ts.",
    })).toBeUndefined();
  });

  it("requires complete-file coverage when TaskFrame requests it", () => {
    const contract = createTestTaskContract({
      objective: "Review all of src/agent/AgentLoop.ts.",
      target: "REPOSITORY",
      effects: { repositoryRead: true },
      constraints: { readOnly: true, requireCompleteFileRead: true },
    });
    const state = stateFor(contract, "Review src/agent/AgentLoop.ts.");
    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/agent/AgentLoop.ts", startLine: 1 },
      result: {
        success: true,
        data: {
          path: "src/agent/AgentLoop.ts",
          startLine: 1,
          endLine: 500,
          totalLines: 900,
          content: "first chunk",
          hasMore: true,
          nextStartLine: 501,
          sourceVersion: "v1",
        },
      },
    });

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "Review complete.",
    })).toMatchObject({ code: "FINAL_WITH_INCOMPLETE_FILE_READ" });
  });

  it("accepts complete repository Skill reads as repository and file coverage evidence", () => {
    const contract = createTestTaskContract({
      objective: "Read the complete release Skill.",
      target: "REPOSITORY",
      effects: { repositoryRead: true },
      constraints: { readOnly: true, requireCompleteFileRead: true },
    });
    const state = stateFor(contract, "Read the complete SKILL.md.");
    state.addToolResult({
      toolName: "skill_read",
      input: { name: "release-audit" },
      result: {
        success: true,
        data: {
          name: "release-audit",
          resource: "SKILL.md",
          path: "skills/release-audit/SKILL.md",
          source: "repository",
          startLine: 1,
          endLine: 3,
          totalLines: 3,
          content: "complete instructions",
          hasMore: false,
        },
      },
    });

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "The complete repository Skill was read.",
    })).toBeUndefined();
  });
});

function stateFor(
  taskContract: ReturnType<typeof createTestTaskContract>,
  userGoal: string,
): AgentState {
  return new AgentState({
    sessionId: "test-session",
    repoPath: process.cwd(),
    userGoal,
    taskContract,
  });
}

function spec(name: string, source: "local" | "mcp"): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: {},
    permissionLevel: "SAFE",
    source,
    annotations: {
      readOnlyHint: name !== "apply_patch",
      destructiveHint: name === "apply_patch",
      idempotentHint: true,
      openWorldHint: name === "web_search",
    },
  };
}
