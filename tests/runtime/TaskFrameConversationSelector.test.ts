import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../../src/session/ConversationHistory.js";
import type { TaskFrame } from "../../src/runtime/TaskFrame.js";
import { selectTaskFrameConversation } from "../../src/runtime/TaskFrameConversationSelector.js";

describe("TaskFrameConversationSelector", () => {
  it("retrieves an older exchange from model-authored semantic queries", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "我们把缓存失效策略叫做 blue-orchid。" },
      { role: "assistant", content: "已记录：blue-orchid 表示写后按标签失效。" },
      ...Array.from({ length: 18 }, (_, index): ConversationMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `unrelated recent exchange ${String(index)}`,
      })),
    ];
    const selection = selectTaskFrameConversation({
      messages,
      frame: frame({
        requiresHistory: true,
        queries: ["blue-orchid 缓存失效策略"],
        includeRecentMessages: 4,
      }),
    });

    expect(selection.messages.map((message) => message.content).join("\n"))
      .toContain("写后按标签失效");
    expect(selection.messages.map((message) => message.content))
      .toEqual(expect.arrayContaining([
        "unrelated recent exchange 17",
      ]));
    expect(selection.matchedAssistantMessages).toBeGreaterThan(0);
    expect(selection.messages.length).toBeLessThanOrEqual(16);
  });

  it("uses only the bounded recent window when TaskFrame requests no history", () => {
    const messages = Array.from({ length: 20 }, (_, index): ConversationMessage => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${String(index)}`,
    }));
    const selection = selectTaskFrameConversation({
      messages,
      frame: frame({
        requiresHistory: false,
        queries: [],
        includeRecentMessages: 3,
      }),
    });

    expect(selection.messages.map((message) => message.content))
      .toEqual(["message 17", "message 18", "message 19"]);
    expect(selection.semanticMatches).toBe(0);
  });
});

function frame(
  conversationEvidence: TaskFrame["conversationEvidence"],
): TaskFrame {
  return {
    version: 1,
    objective: "Resolve the current conversation-dependent request.",
    target: "SESSION",
    effects: {
      answer: true,
      repositoryRead: false,
      repositoryWrite: "NONE",
      webEvidence: false,
      knowledgeEvidence: false,
      commandExecution: false,
      verification: "NONE",
      delegation: false,
      mcp: false,
    },
    constraints: {
      readOnly: false,
      noWeb: false,
      noCommands: false,
      noDelegation: false,
      noMcp: false,
      requireCompleteFileRead: false,
    },
    collaboration: {
      requirement: "NONE",
      changeProposal: false,
      review: false,
      requestedAgents: null,
    },
    conversationEvidence,
    completionCriteria: ["Use the relevant conversation evidence."],
    confidence: 0.95,
    ambiguities: [],
    rationale: "The current request refers to an older session decision.",
  };
}
