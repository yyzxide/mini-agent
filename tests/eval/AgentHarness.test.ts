import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/eval/AgentHarness.js";

const createdRepos: string[] = [];

afterEach(async () => {
  for (const repoPath of createdRepos.splice(0)) {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

describe("AgentHarness", () => {
  it("runs a scripted repository-editing scenario end to end", async () => {
    const harness = new AgentHarness();
    const result = await harness.runScenario({
      name: "append demo line",
      userGoal: "append hello to demo.txt",
      files: {
        "demo.txt": "demo\n",
      },
      decisions: [
        {
          type: "APPLY_PATCH",
          description: "Append hello to demo.txt",
          patch: [
            "diff --git a/demo.txt b/demo.txt",
            "--- a/demo.txt",
            "+++ b/demo.txt",
            "@@ -1 +1,2 @@",
            " demo",
            "+hello from harness",
            "",
          ].join("\n"),
        },
        {
          type: "TOOL_CALL",
          toolName: "git_diff",
          input: {},
        },
        {
          type: "FINAL",
          success: true,
          summary: "Appended hello from harness.",
        },
      ],
      expected: {
        success: true,
        diffContains: ["+hello from harness"],
        filesContain: {
          "demo.txt": "hello from harness",
        },
      },
    });
    createdRepos.push(result.repoPath);

    expect(result.run.success).toBe(true);
    expect(result.llmCalls).toBeGreaterThanOrEqual(3);
  });
});
