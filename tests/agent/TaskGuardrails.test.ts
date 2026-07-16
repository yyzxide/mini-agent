import { describe, expect, it } from "vitest";
import { AgentState } from "../../src/agent/AgentState.js";
import { createAgentCheckpoint } from "../../src/agent/AgentCheckpoint.js";
import { buildTaskCompletionContract } from "../../src/agent/TaskCompletionContract.js";
import {
  requiresRepositoryFileChange,
  validateAgentDecisionGuardrails,
} from "../../src/agent/TaskGuardrails.js";

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
});

function stateFor(userGoal: string): AgentState {
  return new AgentState({ sessionId: "session", repoPath: "/repo", userGoal });
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

function successfulFinal() {
  return { type: "FINAL", success: true, summary: "Done." } as const;
}
