import type { AgentDecision } from "../agent/AgentDecision.js";
import { errorToMessage } from "../utils/errors.js";
import { DecisionParser } from "./DecisionParser.js";
import type { LlmClient, LlmInput } from "./LlmClient.js";
import { buildUserPrompt, CODING_AGENT_SYSTEM_PROMPT } from "./prompts.js";

export interface OpenAICompatibleClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  decisionParser?: DecisionParser;
}

export class OpenAICompatibleClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly decisionParser: DecisionParser;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.MINI_AGENT_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = options.apiKey ?? process.env.MINI_AGENT_API_KEY;
    this.model = options.model ?? process.env.MINI_AGENT_MODEL;
    this.temperature = options.temperature ?? readNumberEnv("MINI_AGENT_TEMPERATURE", 0.2);
    this.maxTokens = options.maxTokens ?? readIntegerEnv("MINI_AGENT_MAX_TOKENS", 4096);
    this.timeoutMs = options.timeoutMs ?? readIntegerEnv("MINI_AGENT_TIMEOUT_MS", 60_000);
    this.fetchFn = options.fetchFn ?? fetch;
    this.decisionParser = options.decisionParser ?? new DecisionParser();
  }

  async chat(input: LlmInput): Promise<AgentDecision> {
    const configurationError = this.validateConfiguration();
    if (configurationError) {
      return { type: "FAILED", error: configurationError };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: CODING_AGENT_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: buildUserPrompt({
                userGoal: input.userGoal,
                context: input.context,
                state: input.state,
                availableTools: input.availableTools,
              }),
            },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const bodyPreview = await response.text().catch(() => "");
        return {
          type: "FAILED",
          error: `LLM request failed: ${response.status} ${response.statusText}${bodyPreview ? ` - ${bodyPreview.slice(0, 500)}` : ""}`,
        };
      }

      const body = await response.json() as OpenAIChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content?.trim();
      if (!content) {
        return { type: "FAILED", error: "LLM response did not include content" };
      }

      try {
        return this.decisionParser.parse(content);
      } catch (error) {
        return { type: "FAILED", error: errorToMessage(error) };
      }
    } catch (error) {
      if (isAbortError(error)) {
        return { type: "FAILED", error: `LLM request timed out after ${this.timeoutMs}ms` };
      }

      return { type: "FAILED", error: `LLM request failed: ${errorToMessage(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateConfiguration(): string | undefined {
    if (!this.apiKey) {
      return "Missing MINI_AGENT_API_KEY";
    }

    if (!this.model) {
      return "Missing MINI_AGENT_MODEL";
    }

    return undefined;
  }
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
