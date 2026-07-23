import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import {
  selectToolsForTaskContract,
  type AgentTaskContract,
} from "../../src/agent/AgentTaskContract.js";
import { buildAgentTaskContract } from "../../src/agent/TaskContractBuilder.js";
import { validateAgentDecisionGuardrails } from "../../src/agent/TaskGuardrails.js";
import { routeTask } from "../../src/agent/TaskRouter.js";
import type { ToolSpec } from "../../src/llm/LlmClient.js";

describe("AgentTaskContract", () => {
  it("models code review and repository analysis as one investigation runtime profile", () => {
    const review = contractFor("帮我检查 src/agent/AgentLoop.ts 有没有 bug");
    const analysis = contractFor("分析当前仓库的设计架构");

    expect(review).toMatchObject({
      kind: "REPOSITORY_INVESTIGATION",
      outputKind: "CODE_REVIEW",
      executionStrategy: "ITERATIVE",
      capabilities: {
        repositoryRead: true,
        repositoryWrite: false,
        commandExecution: false,
        webAccess: false,
      },
      evidence: {
        repositoryRead: true,
        completeFileRead: true,
      },
    });
    expect(analysis).toMatchObject({
      kind: "REPOSITORY_INVESTIGATION",
      outputKind: "REPOSITORY_ANALYSIS",
      capabilities: review.capabilities,
    });
  });

  it("turns direct and web answers into bounded AgentLoop contracts", () => {
    const direct = contractFor("你好，你是谁");
    const web = contractFor("查询今天 TypeScript 的最新版本");

    expect(direct).toMatchObject({
      kind: "DIRECT_RESPONSE",
      executionStrategy: "SINGLE_SHOT",
      maxSteps: 1,
    });
    expect(Object.values(direct.capabilities).every((enabled) => !enabled)).toBe(true);

    expect(web).toMatchObject({
      kind: "WEB_RESEARCH",
      executionStrategy: "ITERATIVE",
      capabilities: { webAccess: true, repositoryRead: false, repositoryWrite: false },
      evidence: { webSearch: true, fetchedWebSourceCount: 1, independentWebDomainCount: 1 },
    });
    expect(contractFor("查询今天世界杯比分")).toMatchObject({
      evidence: { webSearch: true, fetchedWebSourceCount: 2, independentWebDomainCount: 2 },
    });
  });

  it("does not expand task capabilities when iterative execution is forced", () => {
    const contract = buildAgentTaskContract({
      userGoal: "你好，你是谁",
      route: routeTask("你好，你是谁"),
      forceIterative: true,
      multiAgentEnabled: true,
    });

    expect(contract).toMatchObject({
      kind: "DIRECT_RESPONSE",
      executionStrategy: "ITERATIVE",
      capabilities: {
        repositoryRead: false,
        repositoryWrite: false,
        commandExecution: false,
        delegation: false,
      },
    });
  });

  it("filters the model-visible tools using task capabilities", () => {
    const tools: ToolSpec[] = [
      spec("read_file", false),
      spec("apply_patch", false),
      spec("web_search", true),
      spec("fetch_url", true),
      spec("knowledge_search", false),
    ];

    expect(selectToolsForTaskContract(tools, contractFor("你好"))).toEqual([]);
    expect(selectToolsForTaskContract(tools, contractFor("查询今天 TypeScript 的最新版本"))
      .map((tool) => tool.name)).toEqual(["web_search", "fetch_url"]);
    expect(selectToolsForTaskContract(tools, contractFor("分析当前仓库的设计架构"))
      .map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("enforces repository evidence before an investigation can finish", () => {
    const contract = contractFor("分析当前仓库的设计架构");
    const state = stateFor(contract, "分析当前仓库的设计架构");

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "这是仓库分析。",
    })).toMatchObject({ code: "FINAL_WITHOUT_REPOSITORY_EVIDENCE" });

    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/agent/AgentLoop.ts" },
      result: {
        success: true,
        data: { path: "src/agent/AgentLoop.ts", startLine: 1, endLine: 10, totalLines: 10, content: "code" },
      },
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "分析依据来自 src/agent/AgentLoop.ts。",
    })).toBeUndefined();
  });

  it("rejects a complete-file review until every target line is covered", () => {
    const contract = contractFor("完整检查 src/agent/AgentLoop.ts 有没有问题");
    const state = stateFor(contract, "完整检查 src/agent/AgentLoop.ts 有没有问题");
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
      summary: "完整检查完成。",
    })).toMatchObject({
      code: "FINAL_WITH_INCOMPLETE_FILE_READ",
      message: expect.stringContaining("startLine=501"),
    });

    state.addToolResult({
      toolName: "read_file",
      input: { path: "src/agent/AgentLoop.ts", startLine: 501 },
      result: {
        success: true,
        data: {
          path: "src/agent/AgentLoop.ts",
          startLine: 501,
          endLine: 900,
          totalLines: 900,
          content: "last chunk",
          hasMore: false,
          sourceVersion: "v1",
        },
      },
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "完整检查完成。",
    })).toBeUndefined();
  });

  it("allows a web task to finish only with gathered citations or an explicit evidence limitation", () => {
    const contract = contractFor("查询今天 TypeScript 的最新版本");
    const state = stateFor(contract, "查询今天 TypeScript 的最新版本");
    state.addToolResult({
      toolName: "web_search",
      input: { query: "TypeScript latest" },
      result: {
        success: true,
        data: { results: [{ title: "Release", url: "https://example.com/release", snippet: "release" }] },
      },
    });

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新版本已经发布。",
    })).toMatchObject({ code: "FINAL_WITHOUT_FRESHNESS_COMPARISON" });

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "当前来源和证据不足，无法核验最新版本。",
    })).toBeUndefined();
  });
});

function contractFor(userGoal: string): AgentTaskContract {
  return buildAgentTaskContract({ userGoal, route: routeTask(userGoal) });
}

function stateFor(contract: AgentTaskContract, userGoal: string): AgentState {
  return new AgentState({
    sessionId: "test-session",
    repoPath: process.cwd(),
    userGoal,
    taskContract: contract,
  });
}

function spec(name: string, openWorld: boolean): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: {},
    permissionLevel: "SAFE",
    source: "local",
    annotations: {
      readOnlyHint: name !== "apply_patch",
      destructiveHint: name === "apply_patch",
      idempotentHint: true,
      openWorldHint: openWorld,
    },
  };
}
