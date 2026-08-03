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

  it("uses a coding-sized default output budget", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"type\":\"PLAN\",\"message\":\"Inspect\"}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    await client.chat(sampleInput());

    const body = JSON.parse(String(calls[0]?.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(16_384);
  });

  it("sends an explicitly configured provider thinking mode", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "secret-key",
      model: "deepseek-v4-flash",
      thinkingMode: "disabled",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"type\":\"PLAN\",\"message\":\"Inspect\"}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    await client.chat(sampleInput());

    const body = JSON.parse(String(calls[0]?.body)) as { thinking?: { type: string } };
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("injects runtime context into semantic TaskFrame compilation", async () => {
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

    const result = await client.compileTaskFrame({
      userGoal: "今天几号？",
      context: "[user] 之前聊过时间",
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain("semantic TaskFrame compiler");
    expect(body.messages[1]?.content).toContain("Runtime context:");
    expect(body.messages[1]?.content).toContain("Current local date:");
    expect(body.messages[1]?.content).toContain("Current user request (authoritative):");
    expect(body.messages[1]?.content).toContain("Background context (use only when it helps answer the current request):");
    expect(body.messages[1]?.content).toContain("[user] 之前聊过时间");
  });

  it("serializes the final-only synthesis constraint into the decision prompt", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"type\":\"FAILED\",\"error\":\"Insufficient evidence\"}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    await client.chat({
      ...sampleInput(),
      availableTools: [],
      decisionConstraint: "FINAL_ONLY",
    });

    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.at(-1)?.content).toContain("FINAL SYNTHESIS ONLY");
    expect(body.messages.at(-1)?.content).toContain("Do not call tools");
  });

  it("uses a dedicated JSON-only prompt for TaskFrame", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: { content: "{\"version\":1}" },
          }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await client.compileTaskFrame({
      userGoal: "Handle it",
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain("semantic TaskFrame compiler");
    expect(body.messages[0]?.content).toContain("Return one JSON object only");
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

    await client.compileTaskFrame({
      userGoal: "你觉得这个有难度吗",
      conversation: [
        { role: "user", content: "写个五子棋小游戏吧" },
        { role: "assistant", content: "已创建 gobang.html。" },
      ],
    });

    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(body.messages[1]?.content).toBe("写个五子棋小游戏吧");
    expect(body.messages[2]?.content).toBe("已创建 gobang.html。");
    expect(body.messages[3]?.content).toContain("你觉得这个有难度吗");
    expect(body.messages[0]?.content).toContain("Interpret the current user request together with recent conversation");
  });

  it("injects prior-turn repository effects as trusted control-plane evidence", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"version\":1}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    await client.compileTaskFrame({
      userGoal: "在哪里",
      conversation: [
        { role: "user", content: "写一个小游戏" },
        {
          role: "assistant",
          content: "小游戏已经写好。",
          executionEvidence: {
            repositoryChanged: false,
            changedFiles: [],
            verificationAfterChange: false,
          },
        },
      ],
    });

    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const ledger = body.messages.find((message) =>
      message.content.startsWith("Runtime-provided prior-turn execution evidence"),
    );
    expect(ledger?.role).toBe("system");
    expect(ledger?.content).toContain("\"repositoryChanged\":false");
    expect(ledger?.content).toContain("only read is not a file created");
  });

  it("preserves selected conversation evidence for iterative task contracts", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"type\":\"FINAL\",\"summary\":\"已核对。\",\"success\":true}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });

    await client.chat({
      ...sampleInput(),
      conversation: [
        { role: "user", content: "之前的问题" },
        { role: "assistant", content: "此前的相关原话" },
      ],
    });

    const body = JSON.parse(String(calls[0]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[1]?.content).toBe("之前的问题");
    expect(body.messages[2]?.content).toBe("此前的相关原话");
    expect(body.messages[3]?.content).toContain("\"userGoal\": \"inspect repository\"");
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
          cache_creation_input_tokens: 3,
          completion_tokens_details: {
            reasoning_tokens: 2,
          },
        },
        choices: [{
          finish_reason: "stop",
          message: {
            content: "收到了。",
            reasoning_content: "private reasoning trace",
          },
        }],
      }), { status: 200 }),
    });

    const result = await client.compileTaskFrame({
      userGoal: "你好",
      context: "上下文",
    });

    expect(result.success).toBe(true);
    expect(client.drainCallMetrics()).toEqual([
      {
        model: "agent-model",
        finishReason: "stop",
        reasoningContentAvailable: true,
        usage: {
          promptTokens: 10,
          completionTokens: 6,
          totalTokens: 16,
          cachedPromptTokens: 4,
          cacheWriteTokens: 3,
          reasoningTokens: 2,
        },
      },
    ]);
    expect(client.drainCallMetrics()).toEqual([]);
  });

  it("does not expose reasoning_content as a TaskFrame response", async () => {
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

    const result = await client.compileTaskFrame({
      userGoal: "我们上次讨论了什么",
      context: "[user] 伦敦大师赛冠军是哪支队伍",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reasoning_content");
    expect(client.drainCallMetrics()).toEqual([
      expect.objectContaining({ reasoningContentAvailable: true }),
    ]);
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
      response_format?: { type: string };
    };
    expect(retryBody.response_format).toEqual({ type: "json_object" });
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
      response_format?: { type: string };
    };
    expect(retryBody.response_format).toEqual({ type: "json_object" });
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

  it("never treats private reasoning_content as an AgentDecision", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: "",
            reasoning_content: "draft {\"type\":\"FINAL\",\"summary\":\"Private\",\"success\":true}",
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"type\":\"FINAL\",\"summary\":\"Public\",\"success\":true}" } }],
      }), { status: 200 })) as unknown as typeof fetch;
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "FINAL", summary: "Public", success: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recovers once from output-budget exhaustion with a larger compact DeepSeek request", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        usage: {
          completion_tokens: 4096,
          completion_tokens_details: { reasoning_tokens: 4096 },
        },
        choices: [{ finish_reason: "length", message: { content: "{", reasoning_content: "thinking" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"type\":\"PLAN\",\"message\":\"Recovered\"}" } }],
      }), { status: 200 })) as unknown as typeof fetch;
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "secret-key",
      model: "deepseek-v4-flash",
      maxTokens: 4096,
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision).toEqual({ type: "PLAN", message: "Recovered" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)) as {
      max_tokens: number;
      thinking?: { type: string };
      response_format?: { type: string };
      messages: Array<{ content: string }>;
    };
    expect(retryBody.max_tokens).toBe(8192);
    expect(retryBody.thinking).toEqual({ type: "disabled" });
    expect(retryBody.response_format).toEqual({ type: "json_object" });
    expect(retryBody.messages.at(-1)?.content).toContain("exhausted its output budget");
  });

  it("returns one precise diagnostic when the recovery budget is also exhausted", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        completion_tokens: 4096,
        completion_tokens_details: { reasoning_tokens: 4096 },
      },
      choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking" } }],
    }), { status: 200 })) as typeof fetch;
    const client = new OpenAICompatibleClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "secret-key",
      model: "agent-model",
      maxTokens: 4096,
      fetchFn,
    });

    const decision = await client.chat(sampleInput());

    expect(decision.type).toBe("FAILED");
    if (decision.type === "FAILED") {
      expect(decision.error).toContain("LLM_OUTPUT_BUDGET_EXHAUSTED");
      expect(decision.error).toContain("finish_reason=length");
      expect(decision.error).toContain("max_tokens=8192");
      expect(decision.error).toContain("reasoning_tokens=4096");
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
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
