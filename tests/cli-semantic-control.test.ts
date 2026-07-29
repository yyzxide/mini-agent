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
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-cli-task-frame-"));
  process.chdir(tempRoot);
  await execFileAsync("git", ["init"], { cwd: tempRoot });
  await fs.writeFile(path.join(tempRoot, "demo.txt"), "task frame evidence\n", "utf8");
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("mini-agent CLI semantic control", () => {
  it("asks the model for a TaskFrame before action decisions", async () => {
    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";
    const bodies: Array<{
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
    }> = [];
    const responses = [
      JSON.stringify({
        version: 1,
        objective: "Read demo.txt and explain its content.",
        target: "REPOSITORY",
        effects: {
          answer: true,
          repositoryRead: true,
          repositoryWrite: "NONE",
          webEvidence: false,
          knowledgeEvidence: false,
          commandExecution: false,
          verification: "NONE",
          delegation: false,
          mcp: false,
        },
        constraints: {
          readOnly: true,
          noWeb: false,
          noCommands: true,
          requireCompleteFileRead: false,
        },
        completionCriteria: ["demo.txt is read before the answer."],
        confidence: 0.99,
        ambiguities: [],
        rationale: "The user requests repository evidence but no modification.",
      }),
      JSON.stringify({
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: "demo.txt" },
        reason: "Read the requested evidence.",
      }),
      JSON.stringify({
        type: "FINAL",
        success: true,
        summary: "demo.txt contains task frame evidence.",
      }),
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: responses.shift() ?? "" } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "请读取 demo.txt 并说明",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[understanding] model_task_frame");
      expect(output).toContain("[tool] read_file");
      expect(output).toContain("[summary] demo.txt contains task frame evidence.");
      expect(bodies).toHaveLength(3);
      expect(bodies[0]?.messages[0]?.content).toContain("semantic TaskFrame compiler");
      expect(bodies[0]?.response_format).toBeUndefined();
      expect(bodies[1]?.response_format).toEqual({ type: "json_object" });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

});

async function captureStdout(action: () => Promise<void>): Promise<string> {
  let output = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return output;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
