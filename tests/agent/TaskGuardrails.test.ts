import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { createAgentCheckpoint } from "../../src/agent/AgentCheckpoint.js";
import { buildTaskCompletionContract } from "../../src/agent/TaskCompletionContract.js";
import {
  requiresRepositoryFileChange,
  validateAgentDecisionGuardrails,
} from "../../src/agent/TaskGuardrails.js";
import { buildAgentTaskContract } from "../../src/agent/TaskContractBuilder.js";
import { routeTask } from "../../src/agent/TaskRouter.js";

describe("TaskGuardrails", () => {
  it("requires a repository change for common configuration and text artifacts", () => {
    expect(requiresRepositoryFileChange("Create notes.txt containing hello.")).toBe(true);
    expect(requiresRepositoryFileChange("Update config.yaml to enable caching.")).toBe(true);
    expect(requiresRepositoryFileChange("修改 package.json 里的 test 脚本")).toBe(true);
  });

  it("does not treat an explanation request as a required file mutation", () => {
    expect(requiresRepositoryFileChange("Explain what package.json is used for.")).toBe(false);
  });

  it("does not reject authoritative local replies because of surface wording", () => {
    const userGoal = "你是什么模型";
    const state = new AgentState({
      sessionId: "session",
      repoPath: "/repo",
      userGoal,
      taskContract: {
        ...buildAgentTaskContract({ userGoal, route: routeTask(userGoal) }),
        deterministicAnswer: "我是 Mini Coding Agent，当前配置的模型标识是 test-model。",
      },
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: state.taskContract.deterministicAnswer!,
    })).toBeUndefined();
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
      taskContract: completed.taskContract,
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
      taskContract: stale.taskContract,
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

  it("requires the second latest-model search view to be authority-targeted", () => {
    const state = webStateFor("Claude 最新的模型是什么？");
    const currentYear = new Date().getFullYear();
    addWebSearch(state, `Claude latest model ${String(currentYear)}`, [{
      title: "Claude roundup",
      url: "https://example.com/claude",
      snippet: "Secondary overview.",
    }]);

    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "web_search",
      input: { query: `Claude model comparison ${String(currentYear)}` },
    })).toMatchObject({
      code: "TEMPORAL_AUTHORITY_SEARCH_REQUIRED",
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "web_search",
      input: { query: `site:anthropic.com Claude latest model ${String(currentYear)}` },
    })).toBeUndefined();
  });

  it("blocks every non-final decision during the Web synthesis reserve", () => {
    const state = webStateFor("Claude 最新的模型是什么？");
    while (state.maxSteps - state.step > 2) state.incrementStep();

    expect(validateAgentDecisionGuardrails(state, {
      type: "TOOL_CALL",
      toolName: "fetch_url",
      input: { url: "https://www.anthropic.com/news" },
    })).toMatchObject({
      code: "WEB_FINAL_SYNTHESIS_RESERVED",
    });
    expect(validateAgentDecisionGuardrails(state, {
      type: "ASK_USER",
      message: "Should I continue searching?",
    })).toMatchObject({
      code: "WEB_FINAL_SYNTHESIS_RESERVED",
    });
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

  it("blocks finals that satisfy evidence counts but do not answer the requested shape", () => {
    const state = webStateFor("这家公司有多少子公司");
    addWebSearch(state, "公司 子公司 数量", [
      { title: "Annual report", url: "https://company.example/report", snippet: "Subsidiaries." },
      { title: "Registry", url: "https://registry.example/company", snippet: "Corporate records." },
    ]);
    addFetchedPage(state, "https://company.example/report", "Annual report subsidiary disclosure.");
    addFetchedPage(state, "https://registry.example/company", "Registry subsidiary disclosure.");

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "这家公司业务很多，详情参考 https://company.example/report",
    })).toMatchObject({ code: "FINAL_DOES_NOT_ANSWER_COUNT" });
  });

  it("requires citations to point to inspected pages instead of search-only candidates", () => {
    const state = webStateFor("核实某项公开事实");
    addWebSearch(state, "某项公开事实", [
      { title: "Inspected", url: "https://first.example/source", snippet: "Evidence." },
      { title: "Search only", url: "https://second.example/candidate", snippet: "Candidate." },
    ]);
    addFetchedPage(state, "https://first.example/source", "Inspected factual evidence.");

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "这项事实已经得到正文支持。https://second.example/candidate",
    })).toMatchObject({
      code: "FINAL_WITHOUT_WEB_CITATION",
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

  it("accepts a current-year site search only after an exact official candidate is fetched", () => {
    const state = webStateFor("Claude 最新的模型是什么？");
    const currentYear = new Date().getFullYear();
    addWebSearch(state, `Claude 最新模型 ${String(currentYear)}`, [
      {
        title: "Claude models overview",
        url: "https://www.anthropic.com/claude",
        snippet: `Claude model overview updated in ${String(currentYear)}.`,
      },
    ]);
    addWebSearch(state, `site:anthropic.com Claude ${String(currentYear)}`, [
      {
        title: "Claude Opus",
        url: "https://www.anthropic.com/claude/opus",
        snippet: "Claude Opus product page.",
      },
      {
        title: "Unrelated result outside the constrained domain",
        url: "https://example.com/claude",
        snippet: "This result must not count as an authority candidate.",
      },
    ]);
    addFetchedPage(
      state,
      "https://www.anthropic.com/claude/opus",
      `Claude Opus 4.1 is an available model in ${String(currentYear)}.`,
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "当前型号是 Claude Opus 4.1。https://www.anthropic.com/claude/opus",
    })).toBeUndefined();
  });

  it("requires fetching an exact candidate from the authority freshness search", () => {
    const state = webStateFor("Claude 最新的模型是什么？");
    const currentYear = new Date().getFullYear();
    addWebSearch(state, `Claude latest model ${String(currentYear)}`, [
      {
        title: "Claude roundup",
        url: "https://example.com/claude-roundup",
        snippet: "A secondary roundup.",
      },
    ]);
    addWebSearch(state, `site:anthropic.com Claude ${String(currentYear)}`, [
      {
        title: "Claude Opus",
        url: "https://www.anthropic.com/claude/opus",
        snippet: "Claude Opus product page.",
      },
    ]);
    addFetchedPage(
      state,
      "https://example.com/claude-roundup",
      `Claude roundup updated in ${String(currentYear)}.`,
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新型号是 Claude Opus。https://example.com/claude-roundup",
    })).toMatchObject({
      code: "FINAL_WITHOUT_AUTHORITATIVE_SOURCE_INSPECTION",
    });
  });

  it("requires visible temporal or version evidence on the inspected authority page", () => {
    const state = webStateFor("Claude 最新的模型是什么？");
    const currentYear = new Date().getFullYear();
    addWebSearch(state, `Claude latest model ${String(currentYear)}`, [
      {
        title: "Claude model results",
        url: "https://example.com/claude",
        snippet: "Search result.",
      },
    ]);
    addWebSearch(state, `site:anthropic.com Claude ${String(currentYear)}`, [
      {
        title: "Anthropic company page",
        url: "https://www.anthropic.com/company",
        snippet: "Company information.",
      },
    ]);
    addFetchedPage(
      state,
      "https://www.anthropic.com/company",
      "Anthropic builds reliable and beneficial artificial intelligence systems.",
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新型号已经确认。https://www.anthropic.com/company",
    })).toMatchObject({
      code: "FINAL_WITHOUT_VISIBLE_FRESHNESS_EVIDENCE",
    });
  });

  it("does not let an off-domain result satisfy a site-constrained authority search", () => {
    const state = webStateFor("Claude 最新的模型是什么？");
    const currentYear = new Date().getFullYear();
    addWebSearch(state, `Claude latest model ${String(currentYear)}`, [
      {
        title: "Claude roundup",
        url: "https://example.com/claude",
        snippet: "Secondary result.",
      },
    ]);
    addWebSearch(state, `site:anthropic.com Claude ${String(currentYear)}`, [
      {
        title: "Unexpected off-domain result",
        url: "https://example.com/not-anthropic",
        snippet: "Search engines may return an off-domain candidate.",
      },
    ]);
    addFetchedPage(
      state,
      "https://example.com/not-anthropic",
      `A Claude model roundup from ${String(currentYear)}.`,
    );

    expect(validateAgentDecisionGuardrails(state, {
      type: "FINAL",
      success: true,
      summary: "最新型号已经确认。https://example.com/not-anthropic",
    })).toMatchObject({
      code: "FINAL_WITHOUT_AUTHORITATIVE_FRESHNESS_SEARCH",
    });
  });
});

function stateFor(userGoal: string): AgentState {
  return new AgentState({
    sessionId: "session",
    repoPath: "/repo",
    userGoal,
    taskContract: buildAgentTaskContract({ userGoal, route: routeTask(userGoal) }),
  });
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
