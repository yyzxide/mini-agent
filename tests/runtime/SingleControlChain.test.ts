import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentLoop } from "../../src/agent/AgentLoop.js";
import type { LlmClient } from "../../src/llm/LlmClient.js";
import { EventStore } from "../../src/session/EventStore.js";
import { SessionStore } from "../../src/session/SessionStore.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

let repoPath: string | undefined;

afterEach(async () => {
  if (repoPath) {
    await fs.rm(repoPath, { recursive: true, force: true });
    repoPath = undefined;
  }
});

describe("TaskFrame single control chain", () => {
  it("resolves the model frame before entering the action loop", async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-task-frame-"));
    const llmClient: LlmClient = {
      compileTaskFrame: async () => ({
        success: true,
        text: JSON.stringify({
          version: 1,
          objective: "Answer the request.",
          target: "DERIVATION",
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
            requireCompleteFileRead: false,
          },
          completionCriteria: ["Return a direct answer."],
          confidence: 0.99,
          ambiguities: [],
          rationale: "No external effect is required.",
        }),
      }),
      chat: async () => ({
        type: "FINAL",
        success: true,
        summary: "TaskFrame completed through the single control chain.",
      }),
    };
    const loop = new AgentLoop({
      repoPath,
      llmClient,
      toolRegistry: createDefaultToolRegistry(),
      sessionStore: new SessionStore({ repoPath }),
      eventStore: new EventStore({ repoPath }),
    });

    const result = await loop.run({
      userGoal: "一种不应进入硬编码分类器的表达",
      nonInteractive: true,
    });

    expect(result).toMatchObject({
      success: true,
      taskKind: "AGENT_TASK",
      summary: "TaskFrame completed through the single control chain.",
    });
  });
});
