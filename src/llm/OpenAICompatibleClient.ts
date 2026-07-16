import type { AgentDecision } from "../agent/AgentDecision.js";
import { formatRuntimeContext } from "../context/RuntimeContext.js";
import { CodeReviewResponseSchema } from "../review/CodeReview.js";
import { CodeReviewVerificationResponseSchema } from "../review/CodeReview.js";
import type { CodeReviewResponse, CodeReviewVerificationResponse } from "../review/CodeReview.js";
import { errorToMessage } from "../utils/errors.js";
import { DecisionParser } from "./DecisionParser.js";
import type { LlmClient, LlmInput } from "./LlmClient.js";
import { buildUserPrompt, CODING_AGENT_SYSTEM_PROMPT } from "./prompts.js";
import type { ConversationMessage } from "../session/ConversationHistory.js";

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
  conversation?: ConversationMessage[] | undefined;
  mode?: "direct" | "web" | "web_rewrite" | "review_json" | "review_verify_json" | undefined;
}

export interface LlmTextResult {
  success: boolean;
  text?: string;
  error?: string;
}

interface LlmTextAttemptResult extends LlmTextResult {
  finishReason?: string;
}

export interface LlmUsageMetrics {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
}

export interface LlmCallMetrics {
  model?: string;
  finishReason?: string;
  usage?: LlmUsageMetrics;
}

export interface LlmReviewInput {
  userGoal: string;
  context: string;
}

export interface LlmReviewResult {
  success: boolean;
  review?: CodeReviewResponse;
  error?: string;
  rawText?: string;
}

export interface LlmReviewVerificationInput {
  userGoal: string;
  context: string;
}

export interface LlmReviewVerificationResult {
  success: boolean;
  verification?: CodeReviewVerificationResponse;
  error?: string;
  rawText?: string;
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
  private readonly callMetricsBuffer: LlmCallMetrics[] = [];

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

    const firstAttempt = await this.requestDecision(input);
    if (firstAttempt.decision) {
      return firstAttempt.decision;
    }

    if (!firstAttempt.retry) {
      return { type: "FAILED", error: firstAttempt.error };
    }

    const retryAttempt = await this.requestDecision(input, firstAttempt.retry);
    if (retryAttempt.decision) {
      return retryAttempt.decision;
    }

    return { type: "FAILED", error: retryAttempt.error };
  }

  async completeText(input: LlmTextInput): Promise<LlmTextResult> {
    const firstAttempt = await this.requestTextCompletion(input);
    if (!firstAttempt.success || !firstAttempt.text) {
      return toPublicTextResult(firstAttempt);
    }

    if ((input.mode ?? "direct") !== "direct" || firstAttempt.finishReason !== "length") {
      return toPublicTextResult(firstAttempt);
    }

    let accumulated = firstAttempt.text;
    let latestAttempt = firstAttempt;

    for (let index = 0; index < 2 && latestAttempt.finishReason === "length"; index += 1) {
      const continuation = await this.requestTextCompletion({
        userGoal: buildContinuationUserGoal(input.userGoal),
        context: buildContinuationContext(input.context, accumulated),
        conversation: input.conversation,
        mode: input.mode,
      });

      if (!continuation.success || !continuation.text) {
        return {
          success: true,
          text: `${accumulated}\n\n[output may be truncated: continuation request failed]`,
        };
      }

      accumulated = mergeContinuationText(accumulated, continuation.text);
      latestAttempt = continuation;
    }

    if (latestAttempt.finishReason === "length") {
      return {
        success: true,
        text: `${accumulated}\n\n[output may be truncated: model reached max token limit]`,
      };
    }

    return {
      success: true,
      text: accumulated,
    };
  }

  async completeReview(input: LlmReviewInput): Promise<LlmReviewResult> {
    const configurationError = this.validateConfiguration();
    if (configurationError) {
      return { success: false, error: configurationError };
    }

    const firstAttempt = await this.requestTextCompletion({
      userGoal: input.userGoal,
      context: input.context,
      mode: "review_json",
    });
    if (!firstAttempt.success || !firstAttempt.text) {
      return { success: false, error: firstAttempt.error ?? "Review request failed" };
    }

    const firstParsed = parseCodeReviewResponse(firstAttempt.text);
    if (firstParsed.success) {
      return { success: true, review: firstParsed.review, rawText: firstAttempt.text };
    }

    const repairContext = [
      input.context,
      "",
      "Previous review JSON was invalid.",
      `Validation error: ${firstParsed.error}`,
      `Previous response preview:\n${firstAttempt.text.slice(0, 1200)}`,
    ].join("\n");

    const secondAttempt = await this.requestTextCompletion({
      userGoal: input.userGoal,
      context: repairContext,
      mode: "review_json",
    });
    if (!secondAttempt.success || !secondAttempt.text) {
      return { success: false, error: secondAttempt.error ?? firstParsed.error };
    }

    const secondParsed = parseCodeReviewResponse(secondAttempt.text);
    if (!secondParsed.success) {
      return {
        success: false,
        error: secondParsed.error,
        rawText: secondAttempt.text,
      };
    }

    return {
      success: true,
      review: secondParsed.review,
      rawText: secondAttempt.text,
    };
  }

  async verifyReview(input: LlmReviewVerificationInput): Promise<LlmReviewVerificationResult> {
    const configurationError = this.validateConfiguration();
    if (configurationError) {
      return { success: false, error: configurationError };
    }

    const firstAttempt = await this.requestTextCompletion({
      userGoal: input.userGoal,
      context: input.context,
      mode: "review_verify_json",
    });
    if (!firstAttempt.success || !firstAttempt.text) {
      return { success: false, error: firstAttempt.error ?? "Review verification failed" };
    }

    const firstParsed = parseReviewVerificationResponse(firstAttempt.text);
    if (firstParsed.success) {
      return { success: true, verification: firstParsed.verification, rawText: firstAttempt.text };
    }

    const repairContext = [
      input.context,
      "",
      "Previous verification JSON was invalid.",
      `Validation error: ${firstParsed.error}`,
      `Previous response preview:\n${firstAttempt.text.slice(0, 1200)}`,
    ].join("\n");

    const secondAttempt = await this.requestTextCompletion({
      userGoal: input.userGoal,
      context: repairContext,
      mode: "review_verify_json",
    });
    if (!secondAttempt.success || !secondAttempt.text) {
      return { success: false, error: secondAttempt.error ?? firstParsed.error };
    }

    const secondParsed = parseReviewVerificationResponse(secondAttempt.text);
    if (!secondParsed.success) {
      return {
        success: false,
        error: secondParsed.error,
        rawText: secondAttempt.text,
      };
    }

    return {
      success: true,
      verification: secondParsed.verification,
      rawText: secondAttempt.text,
    };
  }

  drainCallMetrics(): LlmCallMetrics[] {
    return this.callMetricsBuffer.splice(0, this.callMetricsBuffer.length);
  }

  private async requestTextCompletion(input: LlmTextInput): Promise<LlmTextAttemptResult> {
    const configurationError = this.validateConfiguration();
    if (configurationError) {
      return { success: false, error: configurationError };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const runtimeContext = formatRuntimeContext();
      const userContent = [
        "Current user request (authoritative):",
        input.userGoal,
        "",
        "Runtime context:",
        runtimeContext,
        ...(input.context ? [
          "",
          "Background context (use only when it helps answer the current request):",
          input.context,
        ] : []),
      ].join("\n");

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
              content: buildTextCompletionSystemPrompt(input.mode ?? "direct"),
            },
            ...(input.conversation ?? []),
            {
              role: "user",
              content: userContent,
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
      this.recordCallMetrics(body);
      const text = extractTextCompletionContent(body);
      if (!text) {
        return { success: false, error: buildEmptyContentError(body) };
      }

      const finishReason = extractFinishReason(body);
      return {
        success: true,
        text,
        ...(finishReason ? { finishReason } : {}),
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { success: false, error: `LLM request timed out after ${this.timeoutMs}ms` };
      }

      return { success: false, error: `LLM request failed: ${errorToMessage(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestDecision(input: LlmInput, retry?: LlmRetryRequest): Promise<LlmAttemptResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const userPrompt = buildUserPrompt({
        userGoal: input.userGoal,
        runtimeContext: formatRuntimeContext(),
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
              content: buildDecisionPrompt(userPrompt, retry),
            },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          ...(retry ? {} : { response_format: { type: "json_object" } }),
        }),
      });

      if (!response.ok) {
        const bodyPreview = await response.text().catch(() => "");
        const error = `LLM request failed: ${response.status} ${response.statusText}${bodyPreview ? ` - ${bodyPreview.slice(0, 500)}` : ""}`;
        if (!retry && shouldRetryWithoutResponseFormat(response.status, bodyPreview)) {
          return {
            retry: {
              kind: "unsupported_response_format",
              error,
            },
            error,
          };
        }

        return {
          error,
        };
      }

      const body = await response.json() as OpenAIChatCompletionResponse;
      this.recordCallMetrics(body);
      const content = extractDecisionContent(body);
      if (!content) {
        const error = buildEmptyContentError(body);
        return retry ? { error } : { retry: { kind: "empty" }, error };
      }

      try {
        return {
          decision: this.decisionParser.parse(content),
          error: "",
        };
      } catch (error) {
        const message = errorToMessage(error);
        return retry ? { error: message } : { retry: { kind: "invalid_json", error: message, content }, error: message };
      }
    } catch (error) {
      if (isAbortError(error)) {
        return {
          error: `LLM request timed out after ${this.timeoutMs}ms`,
        };
      }

      return {
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

  private recordCallMetrics(body: OpenAIChatCompletionResponse): void {
    const usage = extractUsageMetrics(body);
    const firstChoice = body.choices?.[0];
    this.callMetricsBuffer.push({
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof firstChoice?.finish_reason === "string" ? { finishReason: firstChoice.finish_reason } : {}),
      ...(usage ? { usage } : {}),
    });
  }
}

interface LlmAttemptResult {
  decision?: AgentDecision;
  retry?: LlmRetryRequest;
  error: string;
}

interface LlmRetryRequest {
  kind: "empty" | "invalid_json" | "unsupported_response_format";
  error?: string;
  content?: string;
}

interface OpenAIChatCompletionResponse {
  model?: unknown;
  usage?: unknown;
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

function toPublicTextResult(result: LlmTextAttemptResult): LlmTextResult {
  return result.success
    ? { success: true, ...(result.text ? { text: result.text } : {}) }
    : { success: false, ...(result.error ? { error: result.error } : {}) };
}

function buildDecisionPrompt(userPrompt: string, retry: LlmRetryRequest | undefined): string {
  if (!retry) {
    return userPrompt;
  }

  if (retry.kind === "empty") {
    return [
      userPrompt,
      "",
      "The previous model response was empty. Return exactly one AgentDecision JSON object in the message content.",
      "Do not use tool_calls. Do not return an empty message.",
    ].join("\n");
  }

  if (retry.kind === "unsupported_response_format") {
    return [
      userPrompt,
      "",
      "The model endpoint rejected response_format=json_object on the previous request.",
      `Previous request error: ${retry.error ?? "unknown error"}`,
      "Return exactly one valid AgentDecision JSON object in the message content.",
      "Do not return markdown, fenced code blocks, prose, or tool_calls.",
    ].join("\n");
  }

  return [
    userPrompt,
    "",
    "The previous model response could not be parsed as an AgentDecision JSON object.",
    `Parser error: ${retry.error ?? "unknown parse error"}`,
    "Return exactly one valid AgentDecision JSON object in the message content.",
    "Do not return markdown, fenced code blocks, shell commands, prose, or tool_calls.",
    retry.content ? `Previous response preview:\n${retry.content.slice(0, 1000)}` : undefined,
  ].filter(Boolean).join("\n");
}

function buildContinuationUserGoal(originalGoal: string): string {
  return [
    "Continue the previous answer for the same request.",
    `Original request: ${originalGoal}`,
    "Do not restart from the beginning.",
    "Do not repeat any earlier text unless a tiny overlap is unavoidable.",
    "Return only the remaining continuation.",
    "If the previous answer started a fenced code block, continue inside it and close it when appropriate.",
  ].join("\n");
}

function buildContinuationContext(previousContext: string | undefined, accumulatedText: string): string {
  return [
    ...(previousContext ? [previousContext, ""] : []),
    "Previously generated partial answer already shown to the user:",
    limitContinuationContext(accumulatedText, 8_000),
  ].join("\n");
}

function limitContinuationContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

function mergeContinuationText(existing: string, continuation: string): string {
  if (!continuation) {
    return existing;
  }

  if (existing.endsWith(continuation)) {
    return existing;
  }

  const maxOverlap = Math.min(existing.length, continuation.length, 400);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      return existing + continuation.slice(size);
    }
  }

  return existing + continuation;
}

function shouldRetryWithoutResponseFormat(status: number, bodyPreview: string): boolean {
  if (![400, 404, 415, 422].includes(status)) {
    return false;
  }

  const normalized = bodyPreview.toLowerCase();
  return normalized.includes("response_format")
    || normalized.includes("json_object")
    || normalized.includes("unsupported")
    || normalized.includes("not support")
    || normalized.includes("invalid parameter");
}

function extractFinishReason(body: OpenAIChatCompletionResponse): string | undefined {
  const value = body.choices?.[0]?.finish_reason;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractTextCompletionContent(body: OpenAIChatCompletionResponse): string | undefined {
  const firstChoice = body.choices?.[0];
  const message = firstChoice?.message;
  return firstNonEmpty([
    extractTextContent(message?.content),
    extractTextContent(firstChoice?.text),
    extractTextContent(body.output_text),
    extractTextContent(message?.reasoning_content),
    extractTextContent(message?.refusal),
  ]);
}

function extractDecisionContent(body: OpenAIChatCompletionResponse): string | undefined {
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

function buildTextCompletionSystemPrompt(mode: "direct" | "web" | "web_rewrite" | "review_json" | "review_verify_json"): string {
  const commonRules = [
    "You are Mini Coding Agent, a helpful local assistant inside the mini-agent coding CLI.",
    "If the user asks your name or identity, identify yourself as Mini Coding Agent. Do not claim that you have no name.",
    "The CLI has five main processing paths: DIRECT_ANSWER, WEB_ANSWER, CODE_REVIEW, AGENT_LOOP, and read-only PLAN. They are selected per request; do not invent other product modes.",
    "Do not tell the user to exit, restart, or open a separate chat to switch processing paths. The CLI routes each new request automatically.",
    "Answer in the same language as the user unless the user asks otherwise.",
    "The current user request is authoritative. Do not answer or repeat an older request unless the current request clearly refers to it.",
    "Use the provided conversation context when it is relevant.",
    "If Context contains Active skills, follow those skill instructions when relevant unless they conflict with the current user request, repository evidence, safety rules, or this system prompt.",
    "Use the provided runtime context as authoritative for current date and time questions. Never call its date 'future' merely because it is later than your training data.",
    "If the user asks what was discussed before, summarize only what appears in the conversation context.",
    "Do not claim that there is no memory when conversation context is present.",
    "In this product, RAG or the knowledge base means the separately indexed repository Markdown/TXT document corpus queried through knowledge_search. It does not mean conversation history or long-term task memory.",
    "Historical memory evidence comes from prior sessions and task summaries. Describe it as retrieval-based memory, never as the product's document RAG knowledge base.",
    "For short follow-up fragments such as '葡萄牙呢', '那这个呢', or 'and Portugal?', infer the omitted topic or predicate from the conversation context when it is clear.",
    "Do not modify files, do not emit AgentDecision JSON, and do not call tools.",
    "Prefer a complete, useful answer over a terse one-line summary.",
    "For casual acknowledgements, corrections, cancellations, or 'never mind / I clicked the wrong thing' style messages, reply naturally like a person in one short sentence.",
    "Do not turn casual chat into a ticket note, task log, operator summary, or third-person report.",
    "Avoid phrases like '用户误触', '未做任何操作', 'the user mis-clicked', or 'no action was taken' unless the user explicitly asks for a formal log entry.",
    "Use short paragraphs or bullets when they improve clarity.",
    "For explicit snippet-only requests, provide complete code in a fenced code block and add only brief notes when useful.",
    "Do not falsely claim that the overall CLI lacks file-writing capability. If the user asks why a file was not created, explain that this chat-style answer path does not apply repository edits, while repository-editing tasks do.",
    "Do not falsely claim that the overall CLI lacks web capability. If a current-data question reaches this chat-style path without web evidence, say that the answer path has no gathered web evidence and suggest using the web-answer mode, rather than saying the product cannot network.",
  ];

  if (mode === "web") {
    return [
      ...commonRules,
      "The context may include web_search and fetch_url results gathered by the CLI.",
      "Base current-fact answers on the provided web context.",
      "Use conversation context to resolve follow-up questions and keep the same topic/scope unless the user clearly changes it.",
      "For sports questions, keep competitions separate. Do not mix World Cup matches with friendlies, qualifiers, or league matches unless the user asks for all competitions.",
      "For ambiguous entities or acronyms, do not assume the domain. If sources show multiple valid interpretations, list them by category and state what clarification would narrow the answer.",
      "For live scores or very recent results, say clearly when the provided sources do not verify the exact current score.",
      "Mention the main source titles or URLs when you rely on web context.",
      "If sources disagree or are insufficient, say that clearly and explain the uncertainty.",
      "Do not invent facts that are not supported by the web context.",
    ].join("\n");
  }

  if (mode === "web_rewrite") {
    return [
      "You are a web question planner for a local assistant.",
      "Your job is to rewrite the user's current question into a standalone web research plan.",
      "Use the conversation memory to resolve follow-up questions, pronouns, omitted topics, and scope.",
      "For very short follow-up fragments such as '葡萄牙呢' or 'and Portugal?', infer the omitted predicate from the previous user question when it is clear.",
      "Do not answer the user's question.",
      "Return JSON only, with no markdown and no prose.",
      "The JSON shape must be:",
      "{\"standaloneQuestion\":\"string\",\"searchQueries\":[\"string\"],\"answerScope\":\"string\",\"sourceHints\":[\"string\"],\"answerInstructions\":[\"string\"],\"needsLiveData\":boolean,\"confidence\":\"high|medium|low\"}",
      "Create 1 to 4 search queries.",
      "If the user asks for current, latest, live, prices, scores, results, news, or recent facts, set needsLiveData to true.",
      "For follow-up questions, preserve the previous topic/scope unless the user clearly changed topic.",
      "For sports questions, keep competitions separate in answerInstructions.",
      "If an entity/acronym can belong to multiple domains and the user did not specify the domain, do not silently choose one. Plan broad searches and add instructions to list major verified interpretations or ask for clarification.",
      "For esports organizations, keep different games/titles and tournaments separate.",
    ].join("\n");
  }

  if (mode === "review_json") {
    return [
      "You are a code review specialist inside a local coding-agent CLI.",
      "Return JSON only. Do not return markdown, bullets, headings, or prose outside JSON.",
      "Review the provided primary file first. Supplemental related files may appear as supporting context.",
      "Do not invent lines, code snippets, APIs, or behavior not present in the provided file content.",
      "Every finding must quote an exact code fragment from the primary file in codeQuote.",
      "Only report a finding when the quoted code supports the claim.",
      "Use certainty=confirmed only when the issue is directly supported by the provided code.",
      "Use certainty=possible when the code suggests a risk but more context would be needed to prove it.",
      "If there are no grounded findings, return an empty findings array and explain that clearly in summary.",
      "Prefer fewer high-signal findings over many weak ones.",
      "The JSON shape must be:",
      "{\"summary\":\"string\",\"overallVerdict\":\"issues_found|no_confirmed_issues|needs_more_context\",\"findings\":[{\"severity\":\"high|medium|low\",\"certainty\":\"confirmed|possible\",\"file\":\"string\",\"line\":123,\"title\":\"string\",\"codeQuote\":\"string\",\"reasoning\":\"string\",\"suggestedFix\":\"string optional\"}],\"followUp\":[\"string\"]}",
    ].join("\n");
  }

  if (mode === "review_verify_json") {
    return [
      "You are a second-pass code review verifier inside a local coding-agent CLI.",
      "Return JSON only. Do not return markdown or prose outside JSON.",
      "You will receive a primary repository file, optional supplemental related files, and a list of preliminary findings.",
      "Your job is to decide which findings are actually supported by the provided code.",
      "Each kept finding must remain grounded in the quoted code from the primary file.",
      "Drop a finding when its claim is not justified by the quoted code or when the reasoning overreaches the evidence.",
      "Keep only high-confidence grounded findings.",
      "The JSON shape must be:",
      "{\"summary\":\"string\",\"findings\":[{\"index\":0,\"keep\":true,\"certainty\":\"confirmed|possible\",\"reasoning\":\"string\",\"suggestedFix\":\"string optional\",\"dropReason\":\"string optional\"}],\"followUp\":[\"string\"]}",
    ].join("\n");
  }

  return commonRules.join("\n");
}

function extractUsageMetrics(body: OpenAIChatCompletionResponse): LlmUsageMetrics | undefined {
  if (!isRecord(body.usage)) {
    return undefined;
  }

  const promptTokens = readOptionalNumber(body.usage.prompt_tokens);
  const completionTokens = readOptionalNumber(body.usage.completion_tokens);
  const totalTokens = readOptionalNumber(body.usage.total_tokens);
  const promptDetails = isRecord(body.usage.prompt_tokens_details) ? body.usage.prompt_tokens_details : undefined;
  const completionDetails = isRecord(body.usage.completion_tokens_details) ? body.usage.completion_tokens_details : undefined;
  const cachedPromptTokens = promptDetails ? readOptionalNumber(promptDetails.cached_tokens) : undefined;
  const reasoningTokens = completionDetails ? readOptionalNumber(completionDetails.reasoning_tokens) : undefined;

  if ([promptTokens, completionTokens, totalTokens, cachedPromptTokens, reasoningTokens].every((value) => value === undefined)) {
    return undefined;
  }

  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
  };
}

function parseCodeReviewResponse(text: string): {
  success: true;
  review: CodeReviewResponse;
} | {
  success: false;
  error: string;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      success: false,
      error: `Review JSON parse failed: ${errorToMessage(error)}`,
    };
  }

  const result = CodeReviewResponseSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      success: false,
      error: `Review schema validation failed${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
    };
  }

  return {
    success: true,
    review: result.data,
  };
}

function parseReviewVerificationResponse(text: string): {
  success: true;
  verification: CodeReviewVerificationResponse;
} | {
  success: false;
  error: string;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      success: false,
      error: `Review verification JSON parse failed: ${errorToMessage(error)}`,
    };
  }

  const result = CodeReviewVerificationResponseSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      success: false,
      error: `Review verification schema validation failed${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
    };
  }

  return {
    success: true,
    verification: result.data,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
