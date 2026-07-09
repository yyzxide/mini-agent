import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";

const execFileAsync = promisify(execFile);

let tempRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-real-api-regression-"));
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("mini-agent real-api style regressions", () => {
  it("survives malformed new-file patches from the model and still writes the file", async () => {
    process.chdir(tempRoot);
    await execFileAsync("git", ["init"], { cwd: tempRoot });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const responses = [
      "{\"type\":\"PLAN\",\"message\":\"将创建 src/generated_feature.ts，实现最长有效括号算法。\"}",
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "创建 src/generated_feature.ts，实现最长有效括号算法。",
        patch: [
          "diff --git a/src/generated_feature.ts b/src/generated_feature.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/generated_feature.ts",
          "@@ -0,0 +1,6 @@",
          "export function longestValidParentheses(s: string): number {",
          "  void s;",
          "  return 0;",
          "}",
          "",
          "",
        ].join("\n"),
      }),
      "{\"type\":\"TOOL_CALL\",\"toolName\":\"git_diff\",\"input\":{}}",
      "{\"type\":\"FINAL\",\"summary\":\"已创建 longest valid parentheses 实现文件。\",\"success\":true}",
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: responses.shift() ?? "fallback" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "帮我写个 最长有效括号",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[patch]");
      expect(output).toContain("[summary]");
      expect(output).not.toContain("AgentDecision schema validation failed");
      await expect(fs.readFile(path.join(tempRoot, "src", "generated_feature.ts"), "utf8"))
        .resolves.toContain("export function longestValidParentheses");
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });
});

async function captureStdout(action: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  });

  try {
    await action();
  } finally {
    spy.mockRestore();
  }

  return chunks.join("");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
