import { describe, expect, it } from "vitest";
import {
  resolveTaskUnderstanding,
  shouldUseSemanticRefinement,
} from "../../src/agent/TaskUnderstandingResolver.js";
import { understandTask } from "../../src/agent/TaskUnderstanding.js";
import type { LlmClient } from "../../src/llm/LlmClient.js";

describe("TaskUnderstandingResolver", () => {
  it("uses model semantics for an indirect repository action", async () => {
    const userGoal = "这个实现看着不太对，你处理一下";
    const deterministic = understandTask(userGoal);
    expect(shouldUseSemanticRefinement(userGoal, deterministic)).toBe(true);

    const resolved = await resolveTaskUnderstanding({
      userGoal,
      deterministic,
      llmClient: clientReturning({
        operation: "CHANGE_REPOSITORY",
        target: "REPOSITORY",
        explicitRepositoryTarget: true,
        explicitMutation: true,
        rationale: "The user asks to correct the current implementation.",
      }),
    });

    expect(resolved.source).toBe("MODEL_REFINED");
    expect(resolved.understanding).toMatchObject({
      operation: "CHANGE_REPOSITORY",
      target: "REPOSITORY",
      explicitMutation: true,
      signals: expect.arrayContaining(["model-semantic-refinement"]),
    });
  });

  it("keeps an explicit read-only constraint even if the model proposes a write", async () => {
    const userGoal = "只分析这个实现，不要修改文件";
    const resolved = await resolveTaskUnderstanding({
      userGoal,
      llmClient: clientReturning({
        operation: "CHANGE_REPOSITORY",
        target: "REPOSITORY",
        explicitRepositoryTarget: true,
        explicitMutation: true,
        rationale: "Incorrectly inferred a change.",
      }),
    });

    expect(resolved.understanding.operation).toBe("ANALYZE_REPOSITORY");
    expect(resolved.understanding.explicitMutation).toBe(false);
  });

  it("does not mistake a negated read-only phrase for a read-only request", async () => {
    const userGoal = "不是让你只分析，把这个问题修掉";
    const resolved = await resolveTaskUnderstanding({
      userGoal,
      llmClient: clientReturning({
        operation: "CHANGE_REPOSITORY",
        target: "REPOSITORY",
        explicitRepositoryTarget: true,
        explicitMutation: true,
        rationale: "The user rejects analysis-only handling and requests a fix.",
      }),
    });

    expect(resolved.understanding).toMatchObject({
      operation: "CHANGE_REPOSITORY",
      explicitMutation: true,
    });
  });

  it("does not grant write intent from an internally inconsistent model proposal", async () => {
    const userGoal = "如果有问题就告诉我具体在哪里";
    const resolved = await resolveTaskUnderstanding({
      userGoal,
      llmClient: clientReturning({
        operation: "CHANGE_REPOSITORY",
        target: "REPOSITORY",
        explicitRepositoryTarget: true,
        explicitMutation: false,
        rationale: "Repository inspection is needed, but no edit was requested.",
      }),
    });

    expect(resolved.understanding).toMatchObject({
      operation: "ANALYZE_REPOSITORY",
      explicitMutation: false,
    });
  });

  it("falls back to deterministic understanding for invalid model output", async () => {
    const userGoal = "如果发现问题就修复，否则告诉我没有问题";
    const deterministic = understandTask(userGoal);
    const resolved = await resolveTaskUnderstanding({
      userGoal,
      deterministic,
      llmClient: {
        chat: async () => ({ type: "FAILED", error: "unused" }),
        completeText: async () => ({ success: true, text: "not json" }),
      },
    });

    expect(resolved.source).toBe("MODEL_FALLBACK");
    expect(resolved.understanding).toEqual(deterministic);
  });
});

function clientReturning(overrides: Record<string, unknown>): LlmClient {
  return {
    chat: async () => ({ type: "FAILED", error: "unused" }),
    completeText: async () => ({
      success: true,
      text: JSON.stringify({
        operation: "ANSWER",
        target: "DERIVATION",
        answerShape: "FREEFORM",
        answerDepth: "BALANCED",
        externalFactPolicy: "NOT_EXTERNAL_FACT",
        explicitWeb: false,
        explicitRepositoryTarget: false,
        explicitMutation: false,
        completeFileRead: false,
        confidence: 0.94,
        ambiguities: [],
        rationale: "Semantic interpretation.",
        ...overrides,
      }),
    }),
  };
}
