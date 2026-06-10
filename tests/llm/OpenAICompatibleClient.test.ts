import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient } from "../../src/llm/OpenAICompatibleClient.js";
import type { LlmInput } from "../../src/llm/LlmClient.js";

describe("OpenAICompatibleClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs an OpenAI-compatible chat completions request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"type\":\"PLAN\",\"message\":\"Inspect repository\"}",
            },
          },
        ],
      }), { status: 200, statusText: "OK" });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      temperature: 0.1,
      maxTokens: 1234,
      timeoutMs: 5000,
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "PLAN", message: "Inspect repository" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer secret-key",
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(body.model).toBe("agent-model");
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(1234);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.content).toContain("availableTools");
  });

  it("returns a clear FAILED decision for HTTP errors", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
    });

    const decision = await client.chat(sampleInput());

    expect(decision.type).toBe("FAILED");
    if (decision.type === "FAILED") {
      expect(decision.error).toContain("502 Bad Gateway");
      expect(decision.error).toContain("bad gateway");
    }
  });

  it("returns a clear FAILED decision for empty model content", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({
      type: "FAILED",
      error: "LLM response did not include content",
    });
  });

  it("returns clear configuration errors", async () => {
    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    const oldModel = process.env.MINI_AGENT_MODEL;
    delete process.env.MINI_AGENT_API_KEY;
    delete process.env.MINI_AGENT_MODEL;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    try {
      await expect(client.chat(sampleInput())).resolves.toEqual({
        type: "FAILED",
        error: "Missing MINI_AGENT_API_KEY",
      });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
      restoreEnv("MINI_AGENT_MODEL", oldModel);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function sampleInput(): LlmInput {
  return {
    userGoal: "inspect repository",
    context: "repo context",
    state: {
      sessionId: "session",
      repoPath: "/repo",
      userGoal: "inspect repository",
      step: 0,
      maxSteps: 20,
      status: "RUNNING",
      messages: [],
      decisions: [],
      toolResults: [],
      commandResults: [],
      patchResults: [],
      lastError: null,
      finalDiff: null,
    },
    availableTools: [
      {
        name: "git_status",
        description: "Show git status",
        inputSchema: {},
        permissionLevel: "SAFE",
      },
    ],
  };
}
