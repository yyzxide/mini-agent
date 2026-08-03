import type { AgentDecision } from "../agent/AgentDecision.js";
import { PRODUCT_CAPABILITY_IDS } from "../agent/CapabilityRegistry.js";
import { formatRuntimeContext } from "../context/RuntimeContext.js";
import { errorToMessage } from "../utils/errors.js";
import { DecisionParser } from "./DecisionParser.js";
import type {
  LlmClient,
  LlmInput,
  TaskFrameCompletionInput,
  TaskFrameCompletionResult,
} from "./LlmClient.js";
import { buildUserPrompt, CODING_AGENT_SYSTEM_PROMPT } from "./prompts.js";
import type { ConversationMessage } from "../session/ConversationHistory.js";

export interface OpenAICompatibleClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingMode?: ThinkingMode;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  decisionParser?: DecisionParser;
}

export type ThinkingMode = "auto" | "enabled" | "disabled";

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const MAX_RECOVERY_OUTPUT_TOKENS = 32_768;

export interface LlmUsageMetrics {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmCallMetrics {
  model?: string;
  finishReason?: string;
  reasoningContentAvailable?: boolean;
  usage?: LlmUsageMetrics;
}

export class OpenAICompatibleClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly thinkingMode: ThinkingMode;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly decisionParser: DecisionParser;
  private readonly callMetricsBuffer: LlmCallMetrics[] = [];

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.MINI_AGENT_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = options.apiKey ?? process.env.MINI_AGENT_API_KEY;
    this.model = options.model ?? process.env.MINI_AGENT_MODEL;
    this.temperature = options.temperature ?? readNumberEnv("MINI_AGENT_TEMPERATURE", 0.2);
    this.maxTokens = options.maxTokens ?? readIntegerEnv("MINI_AGENT_MAX_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
    this.thinkingMode = options.thinkingMode ?? readThinkingModeEnv("MINI_AGENT_THINKING_MODE", "auto");
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

  async compileTaskFrame(
    input: TaskFrameCompletionInput,
  ): Promise<TaskFrameCompletionResult> {
    return await this.requestTaskFrameCompilation(input);
  }

  drainCallMetrics(): LlmCallMetrics[] {
    return this.callMetricsBuffer.splice(0, this.callMetricsBuffer.length);
  }

  private async requestTaskFrameCompilation(
    input: TaskFrameCompletionInput,
  ): Promise<TaskFrameCompletionResult> {
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
              content: buildTaskFrameSystemPrompt(),
            },
            ...formatConversationForModel(input.conversation),
            {
              role: "user",
              content: userContent,
            },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          ...buildThinkingRequest(this.thinkingMode),
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

      return {
        success: true,
        text,
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
        ...(input.decisionConstraint ? { decisionConstraint: input.decisionConstraint } : {}),
      });
      const requestMaxTokens = retry?.kind === "output_budget_exhausted"
        ? Math.max(this.maxTokens, Math.min(this.maxTokens * 2, MAX_RECOVERY_OUTPUT_TOKENS))
        : this.maxTokens;
      const retryThinkingMode = retry?.kind === "output_budget_exhausted"
        && supportsAdaptiveThinking(this.baseUrl, this.model)
        ? "disabled"
        : this.thinkingMode;
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
            ...formatConversationForModel(input.conversation),
            {
              role: "user",
              content: buildDecisionPrompt(userPrompt, retry),
            },
          ],
          temperature: this.temperature,
          max_tokens: requestMaxTokens,
          ...buildThinkingRequest(retryThinkingMode),
          ...(retry?.kind === "unsupported_response_format" ? {} : { response_format: { type: "json_object" } }),
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
        const budgetError = buildOutputBudgetError(body, requestMaxTokens);
        const error = budgetError ?? buildEmptyContentError(body);
        if (retry) {
          return { error };
        }
        return {
          retry: budgetError
            ? { kind: "output_budget_exhausted", error: budgetError }
            : { kind: "empty" },
          error,
        };
      }

      try {
        return {
          decision: this.decisionParser.parse(content),
          error: "",
        };
      } catch (error) {
        const message = errorToMessage(error);
        const budgetError = buildOutputBudgetError(body, requestMaxTokens);
        const responseError = budgetError ?? message;
        if (retry) {
          return { error: responseError };
        }
        return {
          retry: budgetError
            ? { kind: "output_budget_exhausted", error: budgetError }
            : { kind: "invalid_json", error: message, content },
          error: responseError,
        };
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
      ...(extractTextContent(firstChoice?.message?.reasoning_content)
        ? { reasoningContentAvailable: true }
        : {}),
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
  kind: "empty" | "invalid_json" | "output_budget_exhausted" | "unsupported_response_format";
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

  if (retry.kind === "output_budget_exhausted") {
    return [
      userPrompt,
      "",
      "The previous response exhausted its output budget before completing a valid AgentDecision.",
      `Provider diagnostic: ${retry.error ?? "finish_reason=length"}`,
      "Use the completed tool evidence already present in the state and return exactly one compact AgentDecision JSON object.",
      "Do not repeat analysis, prose, markdown, fenced code blocks, or tool_calls.",
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

function extractTextCompletionContent(body: OpenAIChatCompletionResponse): string | undefined {
  const firstChoice = body.choices?.[0];
  const message = firstChoice?.message;
  return firstNonEmpty([
    extractTextContent(message?.content),
    extractTextContent(firstChoice?.text),
    extractTextContent(body.output_text),
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

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function buildOutputBudgetError(
  body: OpenAIChatCompletionResponse,
  requestMaxTokens: number,
): string | undefined {
  const firstChoice = body.choices?.[0];
  if (firstChoice?.finish_reason !== "length") {
    return undefined;
  }

  const usage = extractUsageMetrics(body);
  const details = [
    `max_tokens=${String(requestMaxTokens)}`,
    usage?.completionTokens === undefined ? undefined : `completion_tokens=${String(usage.completionTokens)}`,
    usage?.reasoningTokens === undefined ? undefined : `reasoning_tokens=${String(usage.reasoningTokens)}`,
  ].filter(Boolean).join("; ");
  return `LLM_OUTPUT_BUDGET_EXHAUSTED: finish_reason=length before a valid AgentDecision was completed (${details}). Increase llm.maxTokens or disable provider thinking for structured decisions if this persists.`;
}

function buildThinkingRequest(mode: ThinkingMode): { thinking?: { type: "enabled" | "disabled" } } {
  return mode === "auto" ? {} : { thinking: { type: mode } };
}

function supportsAdaptiveThinking(baseUrl: string, model: string | undefined): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com")) {
      return true;
    }
  } catch {
    // Configuration validation and fetch provide the actionable URL error later.
  }
  return model?.toLowerCase().startsWith("deepseek-") === true;
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

function buildTaskFrameSystemPrompt(): string {
  return [
      "You are the semantic TaskFrame compiler for a local coding agent.",
      "Interpret the current user request together with recent conversation. Do not answer the request and do not choose a tool yet.",
      "Describe the objective, requested effects, explicit constraints, and evidence-based completion criteria without assigning a runtime mode.",
      "An action mentioned as history, documentation, a quotation, or the object of a question is not necessarily an action requested now.",
      "Runtime-provided prior-turn execution evidence is authoritative about whether a repository change actually happened. Existing or merely read files are not artifacts created by that turn.",
      "repositoryWrite is NONE when no edit is requested, CONDITIONAL when edits are allowed only if investigation establishes a need, and REQUIRED when a repository change is itself the requested outcome.",
      "Requests to optimize, improve, refactor, rewrite, implement, create, or update a repository artifact make the change itself the requested outcome, so use repositoryWrite=REQUIRED. Reserve CONDITIONAL for inspect/review/diagnose-and-fix-if-needed requests where reporting no necessary change is an acceptable completion.",
      "Set collaboration.requirement to REQUIRED only when the user explicitly requires subagent work, OPTIONAL when delegation is requested as a preference, and NONE otherwise. Record required writer/reviewer outcomes separately.",
      "Set conversationEvidence.requiresHistory when the task depends on an older statement, decision, artifact, constraint, or topic beyond the recent exchange. Set purpose=REFERENT for an ordinary cross-turn reference and purpose=PRIOR_RESPONSE_AUDIT only when the user is asking to inspect, challenge, or correct an earlier assistant response. Provide concise semantic queries for retrieving that evidence; do not guess the answer.",
      "When webEvidence is true, classify its evidence profile instead of choosing numeric thresholds. Use ORDINARY/GENERAL_LOOKUP for definitions, explanations, and generic requests to search the Web. Do not elevate a request merely because current information could be useful or because a result may contain a date or version.",
      "Use CORROBORATED/USER_REQUESTED_CORROBORATION only when the user explicitly asks for multiple independent sources or comparison. Use CURRENT/VOLATILE_CURRENT_CLAIM only for an explicitly latest/current/time-bound request or an inherently volatile fact. Use HIGH_STAKES/HIGH_STAKES_DOMAIN only when wrong or stale medical, legal, financial, or safety information could materially harm the user.",
      "Set webEvidencePolicy.ranking=SUPERLATIVE only when the user actually requests a ranking, top/best/most result, or equivalent superlative. Otherwise use REPRESENTATIVE so search queries cannot silently strengthen the scope.",
      "Set readOnly only when the user actually prohibits changes. Set noWeb, noCommands, noDelegation, or noMcp only for explicit prohibitions.",
      "Set effects.verificationBasis=USER_REQUIRED only when the user explicitly asks to run or pass a particular verification strength (syntax/static/test/build/lint/typecheck). Otherwise use TASK_INFERRED; the runtime will select a compatible level from the files actually changed.",
      `For questions about Mini Coding Agent's own capabilities, set target=PRODUCT and classify productCapability.act. Use INVENTORY for a capability list, AVAILABILITY for whether selected capabilities exist, and EXPLAIN_LIMITATION when the user asks about a prior denial or a capability boundary. Select only IDs from: ${PRODUCT_CAPABILITY_IDS.join(", ")}. This is semantic classification; do not match fixed question wording.`,
      "For other product questions that are not about capability availability, use productCapability.act=NONE. For a general inventory, capabilityIds may be empty; for focused availability or limitation questions, include the relevant capability IDs.",
      "Return one JSON object only with this exact shape:",
      "{\"version\":1,\"objective\":\"string\",\"target\":\"REPOSITORY|WORLD|PRODUCT|SESSION|DERIVATION|MIXED\",\"productCapability\":{\"act\":\"NONE|INVENTORY|AVAILABILITY|EXPLAIN_LIMITATION\",\"capabilityIds\":[\"ProductCapabilityId\"]},\"answer\":{\"shape\":\"DEFINITION|COUNT|ENUMERATION|RELATION|IDENTITY|EXPLANATION|FREEFORM\",\"depth\":\"BRIEF|BALANCED|DETAILED\"},\"effects\":{\"answer\":boolean,\"repositoryRead\":boolean,\"repositoryWrite\":\"NONE|CONDITIONAL|REQUIRED\",\"webEvidence\":boolean,\"knowledgeEvidence\":boolean,\"commandExecution\":boolean,\"verification\":\"NONE|SYNTAX|STATIC|TEST\",\"verificationBasis\":\"TASK_INFERRED|USER_REQUIRED\",\"delegation\":boolean,\"mcp\":boolean},\"webEvidencePolicy\":{\"profile\":\"ORDINARY|CORROBORATED|CURRENT|HIGH_STAKES\",\"basis\":\"GENERAL_LOOKUP|USER_REQUESTED_CORROBORATION|VOLATILE_CURRENT_CLAIM|HIGH_STAKES_DOMAIN\",\"ranking\":\"REPRESENTATIVE|SUPERLATIVE\"},\"constraints\":{\"readOnly\":boolean,\"noWeb\":boolean,\"noCommands\":boolean,\"noDelegation\":boolean,\"noMcp\":boolean,\"requireCompleteFileRead\":boolean},\"collaboration\":{\"requirement\":\"NONE|OPTIONAL|REQUIRED\",\"changeProposal\":boolean,\"review\":boolean,\"requestedAgents\":number|null},\"conversationEvidence\":{\"purpose\":\"CONTEXT|REFERENT|PRIOR_RESPONSE_AUDIT\",\"requiresHistory\":boolean,\"queries\":[\"string\"],\"includeRecentMessages\":number},\"completionCriteria\":[\"string\"],\"confidence\":number,\"ambiguities\":[\"string\"],\"rationale\":\"short string\"}",
      "Completion criteria describe observable outcomes, not internal labels. confidence must be between 0 and 1.",
  ].join("\n");
}

function formatConversationForModel(
  conversation: ConversationMessage[] | undefined,
): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const messages = (conversation ?? []).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const ledger = (conversation ?? []).flatMap((message, index) => (
    message.executionEvidence
      ? [{
          turn: index + 1,
          role: message.role,
          repositoryChanged: message.executionEvidence.repositoryChanged,
          changedFiles: message.executionEvidence.changedFiles,
          verificationAfterChange: message.executionEvidence.verificationAfterChange,
        }]
      : []
  ));
  if (ledger.length === 0) {
    return messages;
  }
  return [
    ...messages,
    {
      role: "system",
      content: [
        "Runtime-provided prior-turn execution evidence (trusted control-plane metadata):",
        JSON.stringify(ledger),
        "A file that existed or was only read is not a file created or modified by that turn. If prior assistant prose conflicts with this ledger, the ledger wins.",
      ].join("\n"),
    },
  ];
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
  const cachedPromptTokens = (promptDetails ? readOptionalNumber(promptDetails.cached_tokens) : undefined)
    ?? readOptionalNumber(body.usage.cache_read_input_tokens);
  const cacheWriteTokens = readOptionalNumber(body.usage.cache_creation_input_tokens);
  const reasoningTokens = completionDetails ? readOptionalNumber(completionDetails.reasoning_tokens) : undefined;

  if ([promptTokens, completionTokens, totalTokens, cachedPromptTokens, cacheWriteTokens, reasoningTokens].every((value) => value === undefined)) {
    return undefined;
  }

  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
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

function readThinkingModeEnv(name: string, fallback: ThinkingMode): ThinkingMode {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "auto" || raw === "enabled" || raw === "disabled" ? raw : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
