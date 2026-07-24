import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { buildAgentTaskContract } from "../../src/agent/TaskContractBuilder.js";
import { buildWebResearchProgress } from "../../src/agent/WebResearchProgress.js";

describe("WebResearchProgress", () => {
  it("moves a latest-model task through authority, inspection, comparison, and synthesis", () => {
    const state = webState("Claude 最新的模型是什么？");
    expect(buildWebResearchProgress(state)).toMatchObject({
      phase: "DISCOVER",
      searchViews: 0,
      requiredSearchViews: 2,
      remainingSteps: 14,
      recommendedAction: "WEB_SEARCH",
    });

    addSearch(state, "Claude latest model 2026", [{
      title: "Claude roundup",
      url: "https://example.com/claude",
      snippet: "Secondary overview.",
    }]);
    expect(buildWebResearchProgress(state)).toMatchObject({
      phase: "AUTHORITY_SEARCH",
      authoritySearchSatisfied: false,
      recommendedAction: "WEB_SEARCH",
    });

    addSearch(state, "site:anthropic.com Claude latest model 2026", [{
      title: "Introducing Claude Opus 4.8",
      url: "https://www.anthropic.com/news/claude-opus-4-8",
      snippet: "Our latest model is Claude Opus 4.8.",
    }]);
    expect(buildWebResearchProgress(state)).toMatchObject({
      phase: "INSPECT_SOURCE",
      authoritySearchSatisfied: true,
      authorityCandidateFetched: false,
      recommendedAction: "FETCH_URL",
    });

    addFetch(
      state,
      "https://www.anthropic.com/news/claude-opus-4-8",
      "Introducing Claude Opus 4.8. Released May 28, 2026 and available today.",
    );
    expect(buildWebResearchProgress(state)).toMatchObject({
      phase: "COMPARE_EVIDENCE",
      authorityCandidateFetched: true,
      visibleFreshnessEvidence: true,
      evidenceReady: true,
      recommendedAction: "FINAL",
    });

    advanceToSynthesisReserve(state);
    expect(buildWebResearchProgress(state)).toMatchObject({
      phase: "SYNTHESIZE",
      synthesisReserved: true,
      evidenceReady: true,
      recommendedAction: "FINAL",
    });
  });

  it("requires a limitation final when the synthesis reserve starts without enough evidence", () => {
    const state = webState("Claude 最新的模型是什么？");
    addSearch(state, "Claude latest model 2026", [{
      title: "Claude roundup",
      url: "https://example.com/claude",
      snippet: "Secondary overview.",
    }]);
    advanceToSynthesisReserve(state);

    expect(buildWebResearchProgress(state)).toMatchObject({
      phase: "SYNTHESIZE",
      synthesisReserved: true,
      evidenceReady: false,
      recommendedAction: "LIMITATION_FINAL",
    });
  });
});

function webState(userGoal: string): AgentState {
  return new AgentState({
    sessionId: "session",
    repoPath: "/repo",
    userGoal,
    taskContract: buildAgentTaskContract({
      userGoal,
      route: { intent: "WEB_ANSWER", reason: "test" },
    }),
  });
}

function addSearch(
  state: AgentState,
  query: string,
  results: Array<{ title: string; url: string; snippet: string }>,
): void {
  state.addToolResult({
    toolName: "web_search",
    input: { query },
    result: { success: true, data: { query, provider: "test", results } },
  });
}

function addFetch(state: AgentState, url: string, text: string): void {
  state.addToolResult({
    toolName: "fetch_url",
    input: { url },
    result: { success: true, data: { finalUrl: url, text } },
  });
}

function advanceToSynthesisReserve(state: AgentState): void {
  while (state.maxSteps - state.step > 2) state.incrementStep();
}
