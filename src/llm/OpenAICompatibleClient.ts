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

export interface LlmTextInput {
  userGoal: string;
  context?: string | undefined;
}

export interface LlmTextResult {
  success: boolean;
  text?: string;
  error?: string;
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

    const firstAttempt = await this.requestDecision(input, false);
    if (firstAttempt.decision) {
      return firstAttempt.decision;
    }

    if (!firstAttempt.retryable) {
      return { type: "FAILED", error: firstAttempt.error };
    }

    const retryAttempt = await this.requestDecision(input, true);
    if (retryAttempt.decision) {
      return retryAttempt.decision;
    }

    return { type: "FAILED", error: retryAttempt.error };
  }

  async completeText(input: LlmTextInput): Promise<LlmTextResult> {
    const configurationError = this.validateConfiguration();
    if (configurationError) {
      return { success: false, error: configurationError };
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
              content: [
                "You are a helpful local assistant inside a coding-agent CLI.",
                "Answer the user's request directly, including general questions and coding questions.",
                "Use the provided conversation context when it is relevant.",
                "If the user asks what was discussed before, summarize only what appears in the conversation context.",
                "Do not claim that there is no memory when conversation context is present.",
                "Do not modify files, do not emit AgentDecision JSON, and do not call tools.",
                "For code requests, provide complete code in a fenced code block and add only brief notes when useful.",
              ].join("\n"),
            },
            {
              role: "user",
              content: input.context
                ? `${input.userGoal}\n\nContext:\n${input.context}`
                : input.userGoal,
            },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
        }),
      });

      if (!response.ok) {
        const bodyPreview = await response.text().catch(() => "");
        return {
          success: false,
          error: `LLM request failed: ${response.status} ${response.statusText}${bodyPreview ? ` - ${bodyPreview.slice(0, 500)}` : ""}`,
        };
      }

      const body = await response.json() as OpenAIChatCompletionResponse;
      const text = extractResponseContent(body);
      if (!text) {
        return { success: false, error: buildEmptyContentError(body) };
      }

      return { success: true, text };
    } catch (error) {
      if (isAbortError(error)) {
        return { success: false, error: `LLM request timed out after ${this.timeoutMs}ms` };
      }

      return { success: false, error: `LLM request failed: ${errorToMessage(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestDecision(input: LlmInput, retryAfterEmptyContent: boolean): Promise<LlmAttemptResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const userPrompt = buildUserPrompt({
        userGoal: input.userGoal,
        context: input.context,
        state: input.state,
        availableTools: input.availableTools,
      });
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
              content: retryAfterEmptyContent
                ? `${userPrompt}\n\nThe previous model response was empty. Return exactly one AgentDecision JSON object in the message content. Do not use tool_calls. Do not return an empty message.`
                : userPrompt,
            },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          ...(retryAfterEmptyContent ? {} : { response_format: { type: "json_object" } }),
        }),
      });

      if (!response.ok) {
        const bodyPreview = await response.text().catch(() => "");
        return {
          retryable: false,
          error: `LLM request failed: ${response.status} ${response.statusText}${bodyPreview ? ` - ${bodyPreview.slice(0, 500)}` : ""}`,
        };
      }

      const body = await response.json() as OpenAIChatCompletionResponse;
      const content = extractResponseContent(body);
      if (!content) {
        return {
          retryable: !retryAfterEmptyContent,
          error: buildEmptyContentError(body),
        };
      }

      try {
        return {
          decision: this.decisionParser.parse(content),
          retryable: false,
          error: "",
        };
      } catch (error) {
        return {
          retryable: false,
          error: errorToMessage(error),
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        return {
          retryable: false,
          error: `LLM request timed out after ${this.timeoutMs}ms`,
        };
      }

      return {
        retryable: false,
        error: `LLM request failed: ${errorToMessage(error)}`,
      };
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

interface LlmAttemptResult {
  decision?: AgentDecision;
  retryable: boolean;
  error: string;
}

interface OpenAIChatCompletionResponse {
  output_text?: unknown;
  choices?: Array<{
    finish_reason?: string;
    text?: unknown;
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      refusal?: unknown;
    };
  }>;
}

function extractResponseContent(body: OpenAIChatCompletionResponse): string | undefined {
  const firstChoice = body.choices?.[0];
  const message = firstChoice?.message;
  return firstNonEmpty([
    extractTextContent(message?.content),
    extractTextContent(firstChoice?.text),
    extractTextContent(body.output_text),
    extractJsonLookingText(message?.reasoning_content),
  ]);
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    return firstNonEmpty(value.map((item) => extractTextContent(item)));
  }

  if (isRecord(value)) {
    return firstNonEmpty([
      extractTextContent(value.text),
      extractTextContent(value.content),
      extractTextContent(value.value),
    ]);
  }

  return undefined;
}

function extractJsonLookingText(value: unknown): string | undefined {
  const text = extractTextContent(value);
  if (!text || !text.includes("{") || !text.includes("}")) {
    return undefined;
  }

  return text;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function buildEmptyContentError(body: OpenAIChatCompletionResponse): string {
  const firstChoice = body.choices?.[0];
  const message = firstChoice?.message;
  const details = [
    firstChoice?.finish_reason ? `finish_reason=${firstChoice.finish_reason}` : undefined,
    message ? `message_keys=${Object.keys(message).join(",") || "<none>"}` : "message=<missing>",
    typeof message?.refusal === "string" && message.refusal.trim().length > 0
      ? `refusal=${message.refusal.slice(0, 200)}`
      : undefined,
  ].filter(Boolean).join("; ");

  return `LLM response did not include parsable content${details ? ` (${details})` : ""}. Try a non-reasoning chat model or increase llm.maxTokens if this keeps happening.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
