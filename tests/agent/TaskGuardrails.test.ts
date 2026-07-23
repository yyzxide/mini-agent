import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { createAgentCheckpoint } from "../../src/agent/AgentCheckpoint.js";
import { buildTaskCompletionContract } from "../../src/agent/TaskCompletionContract.js";
import {
  requiresRepositoryFileChange,
  validateAgentDecisionGuardrails,
} from "../../src/agent/TaskGuardrails.js";
import { buildAgentTaskContract } from "../../src/agent/TaskContractBuilder.js";

describe("TaskGuardrails", () => {
  it("requires a repository change for common configuration and text artifacts", () => {
    expect(requiresRepositoryFileChange("Create notes.txt containing hello.")).toBe(true);
    expect(requiresRepositoryFileChange("Update config.yaml to enable caching.")).toBe(true);
    expect(requiresRepositoryFileChange("修改 package.json 里的 test 脚本")).toBe(true);
  });

  it("does not treat an explanation request as a required file mutation", () => {
    expect(requiresRepositoryFileChange("Explain what package.json is used for.")).toBe(false);
  });

  it("requires post-patch verification for source and configuration changes, but not documentation", () => {
    expect(buildTaskCompletionContract(stateFor("Add subtract to src/math.ts."))).toMatchObject({
      kind: "SOURCE_CHANGE",
      requiresRepositoryChange: true,
      requiresVerification: true,
      requiredVerificationLevel: "STATIC",
    });
    expect(buildTaskCompletionContract(stateFor("Update package.json to add a build script."))).toMatchObject({
      kind: "CONFIGURATION_CHANGE",
      requiresRepositoryChange: true,
      requiresVerification: true,
      requiredVerificationLevel: "STATIC",
    });
    expect(buildTaskCompletionContract(stateFor("Create docs/USAGE.md with npm test instructions."))).toMatchObject({
      kind: "DOCUMENTATION_CHANGE",
      requiresRepositoryChange: true,
      requiresVerification: false,
      requiredVerificationLevel: "NONE",
    });
  });

  it("blocks a successful final when source code was changed without verification", () => {
    const state = stateFor("Add subtract to src/math.ts.");
    addSuccessfulPatch(state, "src/math.ts");

    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toMatchObject({
      code: "FINAL_WITHOUT_REQUIRED_VERIFICATION",
    });
  });

  it("treats a passing verification as stale after a later successful patch", () => {
    const state = stateFor("Update src/math.ts and verify the tests.");
    addCommand(state, "npm test", true);
    addSuccessfulPatch(state, "src/math.ts");

    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toMatchObject({
      code: "FINAL_WITH_STALE_VERIFICATION",
    });
  });

  it("accepts source changes only after a later verification passes", () => {
    const state = stateFor("Update src/math.ts and verify the tests.");
    addSuccessfulPatch(state, "src/math.ts");
    addCommand(state, "npm test", false);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toMatchObject({
      code: "FINAL_IGNORES_VERIFICATION_FAILURE",
    });

    addCommand(state, "npm test", true);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toBeUndefined();
  });

  it("does not let diff hygiene satisfy a TypeScript source change", () => {
    const state = stateFor("Update src/math.ts.");
    addSuccessfulPatch(state, "src/math.ts");
    addCommand(state, "git diff --check", true);

    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toMatchObject({
      code: "FINAL_WITH_INSUFFICIENT_VERIFICATION",
    });
    addCommand(state, "npx tsc --noEmit src/math.ts", true);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toBeUndefined();
  });

  it("accepts syntax checks for dynamic source but rejects unrelated file checks", () => {
    const state = stateFor("Update src/app.js.");
    addSuccessfulPatch(state, "src/app.js");
    addCommand(state, "node --check src/other.js", true);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toMatchObject({
      code: "FINAL_WITH_INSUFFICIENT_VERIFICATION",
    });
    addCommand(state, "node --check src/app.js", true);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toBeUndefined();
  });

  it("requires tests for bug fixes even when static checks pass", () => {
    const state = stateFor("Fix the regression in src/math.ts.");
    expect(buildTaskCompletionContract(state)).toMatchObject({ requiredVerificationLevel: "TEST" });
    addSuccessfulPatch(state, "src/math.ts");
    addCommand(state, "npx tsc --noEmit src/math.ts", true);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toMatchObject({
      code: "FINAL_WITH_INSUFFICIENT_VERIFICATION",
    });
    addCommand(state, "npm test", true);
    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toBeUndefined();
  });

  it("allows documentation changes to complete after the patch without a command", () => {
    const state = stateFor("Create docs/USAGE.md with a usage section.");
    addSuccessfulPatch(state, "docs/USAGE.md");

    expect(validateAgentDecisionGuardrails(state, successfulFinal())).toBeUndefined();
  });

  it("preserves completion evidence across checkpoint recovery", () => {
    const completed = stateFor("Update src/math.ts and verify the tests.");
    addSuccessfulPatch(completed, "src/math.ts");
    addCommand(completed, "npm test", true);
    const resumedCompleted = new AgentState({
      sessionId: "session",
      repoPath: "/repo",
      userGoal: completed.userGoal,
      recoveredCheckpoint: createAgentCheckpoint({ state: completed }),
    });
    expect(validateAgentDecisionGuardrails(resumedCompleted, successfulFinal())).toBeUndefined();

    const stale = stateFor("Update src/math.ts and verify the tests.");
    addCommand(stale, "npm test", true);
    addSuccessfulPatch(stale, "src/math.ts");
    const resumedStale = new AgentState({
      sessionId: "session",
      repoPath: "/repo",
      userGoal: stale.userGoal,
      recoveredCheckpoint: createAgentCheckpoint({ state: stale }),
    });
    expect(validateAgentDecisionGuardrails(resumedStale, successfulFinal())).toMatchObject({
      code: "FINAL_WITH_STALE_VERIFICATION",
    });
  });

  it("blocks a web query that silently strengthens a representative request into a ranking", () => {
    const state = webStateFor("Kanye West 有哪些知名的歌曲？");

    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "web_search",
      input: { query: "Kanye West 最知名的歌曲" },
    })).toMatchObject({
      code: "WEB_QUERY_SCOPE_STRENGTHENED",
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "web_search",
      input: { query: "Kanye West 知名歌曲" },
    })).toBeUndefined();
  });

  it("blocks guessed fetch URLs and permits exact search-result URLs", () => {
    const state = webStateFor("核实某项公开事实");
    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "fetch_url",
      input: { url: "https://example.com/guessed" },
    })).toMatchObject({
      code: "FETCH_URL_WITHOUT_GROUNDED_URL",
    });

    state.addToolResult({
      toolName: "web_search",
      input: { query: "公开事实" },
      result: {
        success: true,
        data: {
          results: [{ title: "Source", url: "https://example.com/source", snippet: "Evidence" }],
        },
      },
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "fetch_url",
      input: { url: "https://example.com/guessed" },
    })).toMatchObject({
      code: "FETCH_URL_NOT_FROM_SEARCH_RESULTS",
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "fetch_url",
      input: { url: "https://example.com/source" },
    })).toBeUndefined();
  });

  it("allows a grounded limitation after web search transport failure", () => {
    const state = webStateFor("核实某项公开事实");
    state.addToolResult({
      toolName: "web_search",
      input: { query: "某项公开事实" },
      result: {
        success: false,
        error: { code: "WEB_SEARCH_FAILED", message: "fetch failed" },
      },
    });

    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "web_search",
      input: { query: "public fact" },
    })).toMatchObject({
      code: "WEB_SEARCH_TRANSPORT_UNAVAILABLE",
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "本轮 web_search 连接失败，当前来源不足，无法核验这项事实。",
    })).toBeUndefined();
    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "这项事实肯定是真的。",
    })).toMatchObject({
      code: "FINAL_WITHOUT_WEB_SEARCH",
    });
  });

  it("requires a second non-equivalent search before asserting a latest model", () => {
    const state = webStateFor("OpenAI 最新的模型是什么？");
    addWebSearch(state, "OpenAI latest model 2026", [
      {
        title: "Introducing GPT-5.5",
        url: "https://openai.com/index/introducing-gpt-5-5/",
        snippet: "April 23, 2026 release.",
      },
    ]);
    addFetchedPage(
      state,
      "https://openai.com/index/introducing-gpt-5-5/",
      "Introducing GPT-5.5. April 23, 2026.",
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新模型是 GPT-5.5。https://openai.com/index/introducing-gpt-5-5/",
    })).toMatchObject({
      code: "FINAL_WITHOUT_FRESHNESS_COMPARISON",
    });
  });

  it("requires one authority-targeted search among latest-model comparisons", () => {
    const state = webStateFor("OpenAI 最新的模型是什么？");
    const stale = [{
      title: "Introducing GPT-5.5",
      url: "https://openai.com/index/introducing-gpt-5-5/",
      snippet: "April 23, 2026 release.",
    }];
    addWebSearch(state, "OpenAI latest model 2026", stale);
    addWebSearch(state, "OpenAI newest model July 2026", stale);
    addFetchedPage(
      state,
      "https://openai.com/index/introducing-gpt-5-5/",
      "Introducing GPT-5.5. April 23, 2026.",
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新模型是 GPT-5.5。https://openai.com/index/introducing-gpt-5-5/",
    })).toMatchObject({
      code: "FINAL_WITHOUT_AUTHORITATIVE_FRESHNESS_SEARCH",
    });
  });

  it("blocks a latest-version conclusion when evidence contains a higher same-family candidate", () => {
    const state = webStateFor("OpenAI 最新的模型是什么？");
    addWebSearch(state, "OpenAI latest model 2026", [
      {
        title: "Introducing GPT-5.5",
        url: "https://openai.com/index/introducing-gpt-5-5/",
        snippet: "April 23, 2026 product release.",
      },
    ]);
    addWebSearch(state, "site:openai.com OpenAI latest model official release", [
      {
        title: "GPT-5.6: Frontier intelligence",
        url: "https://openai.com/index/gpt-5-6/",
        snippet: "July 9, 2026 product release.",
      },
      {
        title: "Introducing GPT-5.5",
        url: "https://openai.com/index/introducing-gpt-5-5/",
        snippet: "April 23, 2026 product release.",
      },
    ]);
    addFetchedPage(
      state,
      "https://openai.com/index/introducing-gpt-5-5/",
      "Introducing GPT-5.5. GPT-5.6 is a newer candidate.",
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新模型是 GPT-5.5。https://openai.com/index/introducing-gpt-5-5/",
    })).toMatchObject({
      code: "FINAL_IGNORES_HIGHER_VERSION_CANDIDATE",
    });
  });

  it("accepts a latest-version answer grounded in an authoritative freshness search", () => {
    const state = webStateFor("OpenAI 最新的模型是什么？");
    addWebSearch(state, "OpenAI latest model 2026", [
      {
        title: "GPT-5.6: Frontier intelligence",
        url: "https://openai.com/index/gpt-5-6/",
        snippet: "July 9, 2026 product release.",
      },
    ]);
    addWebSearch(state, "site:openai.com OpenAI latest model official release", [
      {
        title: "GPT-5.6: Frontier intelligence",
        url: "https://openai.com/index/gpt-5-6/",
        snippet: "July 9, 2026 product release.",
      },
    ]);
    addFetchedPage(
      state,
      "https://openai.com/index/gpt-5-6/",
      "GPT-5.6 launches for general availability on July 9, 2026.",
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新系列是 GPT-5.6。https://openai.com/index/gpt-5-6/",
    })).toBeUndefined();
  });
});

function stateFor(userGoal: string): AgentState {
  return new AgentState({ sessionId: "session", repoPath: "/repo", userGoal });
}

function webStateFor(userGoal: string): AgentState {
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

function addSuccessfulPatch(state: AgentState, file: string): void {
  state.addPatchResult({
    patch: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`,
    result: { success: true },
  });
}

function addCommand(state: AgentState, command: string, success: boolean): void {
  state.addCommandResult({
    command,
    cwd: "/repo",
    exitCode: success ? 0 : 1,
    stdout: "",
    stderr: "",
    durationMs: 1,
    success,
    timedOut: false,
    truncated: false,
  });
}

function addWebSearch(
  state: AgentState,
  query: string,
  results: Array<{ title: string; url: string; snippet: string }>,
): void {
  state.addToolResult({
    toolName: "web_search",
    input: { query },
    result: {
      success: true,
      data: { query, provider: "duckduckgo_html", results },
    },
  });
}

function addFetchedPage(state: AgentState, url: string, text: string): void {
  state.addToolResult({
    toolName: "fetch_url",
    input: { url },
    result: {
      success: true,
      data: { finalUrl: url, text },
    },
  });
}

function successfulFinal() {
  return { type: "FINAL", success: true, summary: "Done." } as const;
}
