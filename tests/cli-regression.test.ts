import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadAgentConfig } from "../src/config/AgentConfig.js";
import { createTestTaskFrame } from "./helpers/TaskFrameContract.js";

const execFileAsync = promisify(execFile);

let tempRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-regression-"));
  process.chdir(tempRoot);
  await execFileAsync("git", ["init"], { cwd: tempRoot });
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("mini-agent unified control-plane regressions", () => {
  it("reads an in-repository absolute path and caps oversized paging hints", async () => {
    const filePath = path.join(tempRoot, "2048.html");
    await fs.writeFile(filePath, "<main>2048</main>\n", "utf8");
    const responses = [
      JSON.stringify(createTestTaskFrame({
        objective: "Read and analyze the requested HTML file.",
        target: "REPOSITORY",
        effects: { repositoryRead: true },
        constraints: { readOnly: true },
      })),
      JSON.stringify({
        type: "TOOL_CALL",
        toolName: "read_file",
        input: { path: filePath, maxLines: 100_000, maxTokens: 100_000 },
      }),
      JSON.stringify({
        type: "FINAL",
        success: true,
        summary: "2048.html contains a main element for the 2048 page.",
      }),
    ];
    const fetchMock = stubLlmResponses(responses);
    vi.stubGlobal("fetch", fetchMock);
    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          `请读取并分析 ${filePath}`,
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[understanding] model_task_frame");
      expect(output).toContain("[tool] read_file");
      expect(output).toContain("✓ read_file");
      expect(output).toContain("[summary] 2048.html contains");
      expect(output).not.toContain("Invalid input");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("continues from web research into a repository write in the same AgentLoop", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const sourceUrl = "https://93.184.216.34/research";
    const responses = [
      JSON.stringify(createTestTaskFrame({
        objective: "Research the requested topic and save the result in report.md.",
        target: "MIXED",
        effects: {
          repositoryWrite: "REQUIRED",
          webEvidence: true,
        },
        completionCriteria: [
          "A public source is searched and fetched.",
          "report.md is created from the gathered evidence.",
        ],
      })),
      JSON.stringify({
        type: "TOOL_CALL",
        toolName: "web_search",
        input: { query: "agent control plane research", maxResults: 3 },
      }),
      JSON.stringify({
        type: "TOOL_CALL",
        toolName: "fetch_url",
        input: { url: sourceUrl },
      }),
      JSON.stringify({
        type: "APPLY_PATCH",
        description: "Save the researched result",
        patch: [
          "diff --git a/report.md b/report.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/report.md",
          "@@ -0,0 +1,3 @@",
          "+# Agent control plane",
          "+",
          `+Source: ${sourceUrl}`,
          "",
        ].join("\n"),
      }),
      JSON.stringify({
        type: "FINAL",
        success: true,
        summary: `Searched, fetched, and wrote report.md. Source: ${sourceUrl}`,
      }),
    ];
    const llmResponses = [...responses];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.startsWith("https://llm.example/")) {
        return llmResponse(llmResponses.shift() ?? "");
      }
      if (value === sourceUrl) {
        return new Response("<article>Agent control planes coordinate tool use and state.</article>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response([
        "<html><body><div class=\"result\">",
        `<a class=\"result__a\" href=\"${sourceUrl}\">Control-plane research</a>`,
        "<div class=\"result__snippet\">Research about agent control planes.</div>",
        "</div></body></html>",
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    process.env.MINI_AGENT_API_KEY = "test-key";

    try {
      const output = await captureStdout(async () => {
        await createProgram().parseAsync([
          "run",
          "联网搜索 agent control plane 的资料，然后写进 report.md",
          "--model",
          "test-model",
          "--base-url",
          "https://llm.example/v1",
        ], { from: "user" });
      });

      expect(output).toContain("[tool] web_search");
      expect(output).toContain("[tool] fetch_url");
      expect(output).toContain("[patch]");
      expect(output).toContain("[summary]");
      expect(output).not.toContain("DIRECT_RESPONSE");
      expect(output).not.toContain("legacy");
      await expect(fs.readFile(path.join(tempRoot, "report.md"), "utf8"))
        .resolves.toContain(sourceUrl);
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
    }
  });

  it("discards an obsolete legacy config marker instead of enabling another runtime", async () => {
    await fs.writeFile(
      path.join(tempRoot, "mini-agent.config.json"),
      JSON.stringify({ version: 1, controlPlane: "legacy", llm: { model: "fixture" } }),
      "utf8",
    );

    const config = await loadAgentConfig(tempRoot);

    expect(config).toMatchObject({ version: 1, llm: { model: "fixture" } });
    expect(config).not.toHaveProperty("controlPlane");
  });
});

function stubLlmResponses(responses: string[]) {
  return vi.fn(async () => llmResponse(responses.shift() ?? ""));
}

function llmResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200 });
}

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
