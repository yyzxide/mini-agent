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
    expect(body.messages[1]?.content).toContain("runtimeContext");
    expect(body.messages[1]?.content).toContain("Current local date:");
    expect(body.messages[1]?.content).not.toContain('\"toolResults\"');
    expect(body.messages[1]?.content).not.toContain('\"patchResults\"');
  });

  it("injects runtime context into direct text completions", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        choices: [{ message: { content: "今天的日期见运行时上下文。" } }],
      }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn,
    });

    const result = await client.completeText({
      userGoal: "今天几号？",
      context: "[user] 之前聊过时间",
      mode: "direct",
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain("runtime context");
    expect(body.messages[1]?.content).toContain("Runtime context:");
    expect(body.messages[1]?.content).toContain("Current local date:");
    expect(body.messages[1]?.content).toContain("Current user request (authoritative):");
    expect(body.messages[1]?.content).toContain("Background context (use only when it helps answer the current request):");
    expect(body.messages[1]?.content).toContain("[user] 之前聊过时间");
  });

  it("preserves recent conversation as role-separated messages", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({ choices: [{ message: { content: "五子棋本身不难。" } }] }), { status: 200 });
      }) as typeof fetch,
    });

    await client.completeText({
      userGoal: "你觉得这个有难度吗",
      conversation: [
        { role: "user", content: "写个五子棋小游戏吧" },
        { role: "assistant", content: "已创建 gobang.html。" },
      ],
      mode: "direct",
    });

    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(body.messages[1]?.content).toBe("写个五子棋小游戏吧");
    expect(body.messages[2]?.content).toBe("已创建 gobang.html。");
    expect(body.messages[3]?.content).toContain("你觉得这个有难度吗");
  });

  it("records usage metrics that can be drained later", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({
        model: "agent-model",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          total_tokens: 16,
          prompt_tokens_details: {
            cached_tokens: 4,
          },
          completion_tokens_details: {
            reasoning_tokens: 2,
          },
        },
        choices: [{ finish_reason: "stop", message: { content: "收到了。" } }],
      }), { status: 200 }),
    });

    const result = await client.completeText({
      userGoal: "你好",
      context: "上下文",
      mode: "direct",
    });

    expect(result.success).toBe(true);
    expect(client.drainCallMetrics()).toEqual([
      {
        model: "agent-model",
        finishReason: "stop",
        usage: {
          promptTokens: 10,
          completionTokens: 6,
          totalTokens: 16,
          cachedPromptTokens: 4,
          reasoningTokens: 2,
        },
      },
    ]);
    expect(client.drainCallMetrics()).toEqual([]);
  });

  it("continues direct answers when the first completion stops due to token length", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "agent-model",
        choices: [{ finish_reason: "length", message: { content: "第一段代码\n```html\n<div>2048" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "agent-model",
        choices: [{ finish_reason: "stop", message: { content: "</div>\n```" } }],
      }), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn,
    });

    const result = await client.completeText({
      userGoal: "写个 2048 页面",
      context: "[user] 需要完整 HTML",
      mode: "direct",
    });

    expect(result).toEqual({
      success: true,
      text: "第一段代码\n```html\n<div>2048</div>\n```",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(retryBody.messages[1]?.content).toContain("Continue the previous answer for the same request.");
    expect(retryBody.messages[1]?.content).toContain("Previously generated partial answer");
  });

  it("accepts reasoning_content as text completion fallback", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "我们上次讨论了伦敦大师赛冠军是哪支队伍。",
            },
          },
        ],
      }), { status: 200 }),
    });

    const result = await client.completeText({
      userGoal: "我们上次讨论了什么",
      context: "[user] 伦敦大师赛冠军是哪支队伍",
      mode: "direct",
    });

    expect(result).toEqual({
      success: true,
      text: "我们上次讨论了伦敦大师赛冠军是哪支队伍。",
    });
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

  it("retries once when model content is empty", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"type\":\"FINAL\",\"summary\":\"Recovered\",\"success\":true}" } }],
      }), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "FINAL", summary: "Recovered", success: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
      response_format?: unknown;
    };
    expect(retryBody.response_format).toBeUndefined();
    expect(retryBody.messages[1]?.content).toContain("previous model response was empty");
  });

  it("retries once when model decision content is not valid JSON", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "```bash\nsudo apt update\n```" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"type\":\"FINAL\",\"summary\":\"Recovered\",\"success\":true}" } }],
      }), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "FINAL", summary: "Recovered", success: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
      response_format?: unknown;
    };
    expect(retryBody.response_format).toBeUndefined();
    expect(retryBody.messages[1]?.content).toContain("could not be parsed as an AgentDecision JSON object");
    expect(retryBody.messages[1]?.content).toContain("Do not return markdown");
  });

  it("retries without response_format when the endpoint rejects json_object mode", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "response_format json_object is not supported by this model",
        },
      }), { status: 400, statusText: "Bad Request" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"type\":\"FINAL\",\"summary\":\"Recovered after fallback\",\"success\":true}" } }],
      }), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "FINAL", summary: "Recovered after fallback", success: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as {
      response_format?: { type: string };
    };
    expect(firstBody.response_format).toEqual({ type: "json_object" });

    const retryBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
      response_format?: unknown;
    };
    expect(retryBody.response_format).toBeUndefined();
    expect(retryBody.messages[1]?.content).toContain("rejected response_format=json_object");
    expect(retryBody.messages[1]?.content).toContain("Return exactly one valid AgentDecision JSON object");
  });

  it("parses array-shaped message content", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: [
                {
                  type: "text",
                  text: "{\"type\":\"PLAN\",\"message\":\"Array content works\"}",
                },
              ],
            },
          },
        ],
      }), { status: 200 }),
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "PLAN", message: "Array content works" });
  });

  it("returns diagnostic FAILED decision when model content stays empty", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking" } }],
      }), { status: 200 }),
    });

    const decision = await client.chat(sampleInput());

    expect(decision.type).toBe("FAILED");
    if (decision.type === "FAILED") {
      expect(decision.error).toContain("LLM response did not include parsable content");
      expect(decision.error).toContain("finish_reason=length");
      expect(decision.error).toContain("message_keys=content,reasoning_content");
    }
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

  it("parses structured code review JSON", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Found one grounded issue.",
                overallVerdict: "issues_found",
                findings: [
                  {
                    severity: "medium",
                    certainty: "confirmed",
                    file: "src/tools/WebSearchTool.ts",
                    line: 139,
                    title: "Hex entities are not decoded",
                    codeQuote: "replace(/&#(\\d+);/g",
                    reasoning: "The decoder only handles decimal numeric entities.",
                  },
                ],
                followUp: [],
              }),
            },
          },
        ],
      }), { status: 200 }),
    });

    const result = await client.completeReview({
      userGoal: "Review src/tools/WebSearchTool.ts for bugs",
      context: "file content here",
    });

    expect(result.success).toBe(true);
    expect(result.review?.findings[0]?.title).toBe("Hex entities are not decoded");
  });

  it("parses structured code review verification JSON", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Keep only the grounded finding.",
                findings: [
                  {
                    index: 0,
                    keep: true,
                    certainty: "possible",
                    reasoning: "The quoted code supports a decoder limitation, but impact still depends on actual input.",
                  },
                ],
                followUp: ["Check real HTML samples."],
              }),
            },
          },
        ],
      }), { status: 200 }),
    });

    const result = await client.verifyReview({
      userGoal: "Verify review findings",
      context: "review verification context",
    });

    expect(result.success).toBe(true);
    expect(result.verification?.findings[0]).toMatchObject({
      index: 0,
      keep: true,
      certainty: "possible",
    });
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
