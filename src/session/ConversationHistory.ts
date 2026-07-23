import type { SessionRecord } from "./SessionTypes.js";
import { estimateTokens } from "../context/TokenEstimator.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationHistoryOptions {
  maxMessages?: number;
  maxChars?: number;
}

export type ConversationSelectionStrategy =
  | "RECENT_HISTORY"
  | "LATEST_REFERENT"
  | "PRIOR_RESPONSE_AUDIT";

export interface ConversationFocusOptions {
  maxMessages?: number;
  maxChars?: number;
}

export interface FocusedConversationHistory {
  messages: ConversationMessage[];
  focusedOnLatestTurn: boolean;
  strategy: ConversationSelectionStrategy;
  matchedAssistantMessages: number;
}

export interface ConversationHistoryTrace {
  totalMessages: number;
  selectedMessages: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  truncated: boolean;
}

export interface ConversationHistoryResult {
  messages: ConversationMessage[];
  trace: ConversationHistoryTrace;
}

const DEFAULT_MAX_MESSAGES = 16;
const DEFAULT_MAX_CHARS = 12_000;
const AUDIT_RECENT_TAIL_MESSAGES = 6;

export interface PriorAssistantClaimMatch {
  index: number;
  content: string;
  matchedTerms: string[];
  score: number;
}

/**
 * Rebuilds chat history from persisted records without leaking tool traces or
 * duplicating direct-answer summaries. Agent-loop summaries are represented as
 * assistant turns because that execution path does not persist a separate
 * ASSISTANT_MESSAGE record.
 */
export function buildConversationHistory(
  records: SessionRecord[],
  options: ConversationHistoryOptions = {},
): ConversationMessage[] {
  return buildConversationHistoryWithTrace(records, options).messages;
}

export function buildConversationHistoryWithTrace(
  records: SessionRecord[],
  options: ConversationHistoryOptions = {},
): ConversationHistoryResult {
  const messages: ConversationMessage[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const message = toConversationMessage(record, records[index - 1]);
    if (!message) {
      continue;
    }

    const previous = messages.at(-1);
    if (previous?.role === message.role && previous.content === message.content) {
      continue;
    }
    messages.push(message);
  }

  const maxMessages = Math.max(0, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS);
  if (maxMessages === 0 || maxChars === 0) {
    return {
      messages: [],
      trace: buildTrace(messages, []),
    };
  }
  const totalChars = messages.reduce((total, message) => total + message.content.length, 0);
  if (messages.length <= maxMessages && totalChars <= maxChars) {
    const selected = messages.slice();
    while (selected[0]?.role === "assistant" && selected.some((message) => message.role === "user")) {
      selected.shift();
    }
    return {
      messages: selected,
      trace: buildTrace(messages, selected),
    };
  }
  const selected: ConversationMessage[] = [];
  let usedChars = 0;

  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (selected.length > 0 && usedChars + message.content.length > maxChars) {
      break;
    }
    if (selected.length === 0 && message.content.length > maxChars) {
      selected.unshift({ ...message, content: message.content.slice(-maxChars) });
      break;
    }
    selected.unshift(message);
    usedChars += message.content.length;
  }

  while (selected[0]?.role === "assistant" && selected.some((message) => message.role === "user")) {
    selected.shift();
  }

  return {
    messages: selected,
    trace: buildTrace(messages, selected),
  };
}

/**
 * Plans the bounded conversation evidence for the current turn.
 *
 * A latest-turn reference selects the immediately preceding exchange so an
 * older topic cannot compete with the referenced subject. A challenge to an
 * earlier assistant response uses a separate audit strategy that pins matching
 * assistant claims and their surrounding turns before filling the remaining
 * budget with recent history.
 */
export function focusConversationHistory(
  messages: ConversationMessage[],
  currentRequest: string,
  options: ConversationFocusOptions = {},
): FocusedConversationHistory {
  const maxMessages = Math.max(0, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS);
  if (maxMessages === 0 || maxChars === 0) {
    return {
      messages: [],
      focusedOnLatestTurn: false,
      strategy: isPriorResponseAuditRequest(currentRequest)
        ? "PRIOR_RESPONSE_AUDIT"
        : "RECENT_HISTORY",
      matchedAssistantMessages: 0,
    };
  }

  if (isPriorResponseAuditRequest(currentRequest)) {
    const matches = findPriorAssistantClaimMatches(messages, currentRequest);
    const selected = selectAuditConversation(messages, matches, { maxMessages, maxChars });
    return {
      messages: selected,
      focusedOnLatestTurn: false,
      strategy: "PRIOR_RESPONSE_AUDIT",
      matchedAssistantMessages: matches.filter((match) =>
        selected.some((message) =>
          message.role === "assistant" && message.content === match.content,
        )).length,
    };
  }

  const focusedOnLatestTurn = isImplicitLatestTurnReference(currentRequest);
  const selected = focusedOnLatestTurn
    ? selectLatestExchange(messages, { maxMessages, maxChars })
    : selectRecentConversation(messages, { maxMessages, maxChars });
  return {
    messages: selected,
    focusedOnLatestTurn,
    strategy: focusedOnLatestTurn ? "LATEST_REFERENT" : "RECENT_HISTORY",
    matchedAssistantMessages: 0,
  };
}

export function findLatestUserMessage(messages: ConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return undefined;
}

/**
 * Detects a dialogue act that asks the assistant to inspect, defend, or correct
 * its own earlier output. Detection is compositional (assistant attribution +
 * challenge/audit), not tied to any domain entity or exact regression phrase.
 */
export function isPriorResponseAuditRequest(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;

  const assistantAttribution = [
    /(?:你|您).{0,14}(?:说(?:过|的)?|说法|回答|回复|提到|写过|写的|输出|声称|告诉)/i,
    /(?:你的|您的).{0,8}(?:回答|回复|说法|原话|输出|表述)/i,
    /(?:自己|回头).{0,8}(?:看看|检查|核对|回看)/i,
    /\b(?:you|your|the assistant).{0,24}\b(?:said|claim(?:ed)?|wrote|answer(?:ed)?|mention(?:ed)?|response|output)\b/i,
  ].some((pattern) => pattern.test(normalized));
  if (!assistantAttribution) return false;

  return [
    /(?:哪来|有没有|是否|是不是|不对|错误|错了|幻觉|编造|捏造|矛盾|否认|承认|核对|检查|看看|回看|原话|撤回|纠正)/i,
    /(?:说过|写过|提过|输出过).{0,4}(?:吗|没有|没)/i,
    /(?:为什么|怎么会|凭什么).{0,10}(?:说|回答|写|声称|输出)/i,
    /(?:说|回答|写|声称|输出).{0,10}(?:为什么|怎么会|对吗|正确吗|真实吗)/i,
    /\b(?:deny|denied|wrong|false|hallucinat(?:e|ed|ion)|fabricat(?:e|ed|ion)|contradict(?:ion|ed)?|check|verify|really say|did you say)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

export function findPriorAssistantClaimMatches(
  messages: ConversationMessage[],
  currentRequest: string,
): PriorAssistantClaimMatch[] {
  const terms = extractPriorClaimTerms(currentRequest);
  if (terms.length === 0) return [];

  return messages
    .map((message, index): PriorAssistantClaimMatch | undefined => {
      if (message.role !== "assistant") return undefined;
      const normalizedContent = normalizeForClaimMatch(message.content);
      const matchedTerms = terms.filter((term) => normalizedContent.includes(term));
      const distinctiveTerms = matchedTerms.filter((term) => term.length >= 3);
      const shortTerms = new Set(matchedTerms.filter((term) => term.length === 2));
      if (distinctiveTerms.length === 0 && shortTerms.size < 2) return undefined;
      const score = matchedTerms.reduce((total, term) => total + Math.min(12, term.length ** 2), 0);
      return { index, content: message.content, matchedTerms, score };
    })
    .filter((match): match is PriorAssistantClaimMatch => match !== undefined)
    .sort((left, right) => right.score - left.score || right.index - left.index);
}

function toConversationMessage(
  record: SessionRecord,
  previousRecord: SessionRecord | undefined,
): ConversationMessage | undefined {
  if (record.type === "USER_MESSAGE") {
    return readMessage(record, "user", "content");
  }
  if (record.type === "ASSISTANT_MESSAGE") {
    // Older sessions persisted every AgentLoop decision as a chat message.
    // AGENT_DECISION already records that trace; it is not conversational history.
    if (previousRecord?.type === "AGENT_DECISION") {
      return undefined;
    }
    return readMessage(record, "assistant", "content");
  }
  if (record.type === "TASK_SUMMARY" && record.payload.success !== false) {
    return readMessage(record, "assistant", "summary");
  }
  return undefined;
}

function readMessage(
  record: SessionRecord,
  role: ConversationMessage["role"],
  key: "content" | "summary",
): ConversationMessage | undefined {
  const value = record.payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return { role, content: value.trim() };
}

function isImplicitLatestTurnReference(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }

  if (/(之前|先前|前面|更早|最开始|历史|previous|earlier|before that)/i.test(normalized)) {
    return false;
  }

  if (/(?:这个|那个)(?:游戏|项目|产品|系统|文件|方案|功能|问题|回答|作品|公司|球队|人物)/i.test(normalized)) {
    return false;
  }

  return /(这个|那个|这些|那些|这段|这份|这次|该(?:代码|项目|实现|方案|文件|功能)|它|上述|上面|刚才|\bthis\b|\bthat\b|\bit\b|\bthese\b|\bthose\b)/i.test(normalized);
}

function buildTrace(
  input: ConversationMessage[],
  output: ConversationMessage[],
): ConversationHistoryTrace {
  return {
    totalMessages: input.length,
    selectedMessages: output.length,
    estimatedInputTokens: estimateConversationTokens(input),
    estimatedOutputTokens: estimateConversationTokens(output),
    truncated: output.length < input.length
      || output.some((message, index) => message.content !== input[input.length - output.length + index]?.content),
  };
}

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message.content),
    0,
  );
}

function selectRecentConversation(
  messages: ConversationMessage[],
  options: Required<ConversationFocusOptions>,
): ConversationMessage[] {
  const selected: ConversationMessage[] = [];
  let usedChars = 0;

  for (let index = messages.length - 1; index >= 0 && selected.length < options.maxMessages; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const remainingChars = options.maxChars - usedChars;
    if (remainingChars <= 0) break;
    if (message.content.length > remainingChars) {
      if (selected.length === 0) {
        selected.unshift({ ...message, content: message.content.slice(-remainingChars) });
      }
      break;
    }
    selected.unshift(message);
    usedChars += message.content.length;
  }

  while (selected[0]?.role === "assistant" && selected.some((message) => message.role === "user")) {
    selected.shift();
  }
  return selected;
}

function selectLatestExchange(
  messages: ConversationMessage[],
  options: Required<ConversationFocusOptions>,
): ConversationMessage[] {
  const latestAssistantIndex = findLastMessageIndex(messages, "assistant");
  if (latestAssistantIndex < 0) {
    return selectRecentConversation(messages, options);
  }
  const precedingUserIndex = findLastMessageIndex(messages, "user", latestAssistantIndex - 1);
  const startIndex = precedingUserIndex >= 0 ? precedingUserIndex : latestAssistantIndex;
  return fitConversationSlice(messages.slice(startIndex, latestAssistantIndex + 1), options);
}

function findLastMessageIndex(
  messages: ConversationMessage[],
  role: ConversationMessage["role"],
  startIndex = messages.length - 1,
): number {
  for (let index = Math.min(startIndex, messages.length - 1); index >= 0; index -= 1) {
    if (messages[index]?.role === role) return index;
  }
  return -1;
}

function fitConversationSlice(
  messages: ConversationMessage[],
  options: Required<ConversationFocusOptions>,
): ConversationMessage[] {
  const selected: ConversationMessage[] = [];
  let usedChars = 0;
  for (const message of messages) {
    if (selected.length >= options.maxMessages) break;
    const remainingChars = options.maxChars - usedChars;
    if (remainingChars <= 0) break;
    const content = message.content.length <= remainingChars
      ? message.content
      : message.content.slice(-remainingChars);
    selected.push({ ...message, content });
    usedChars += content.length;
  }
  return selected;
}

function selectAuditConversation(
  messages: ConversationMessage[],
  matches: PriorAssistantClaimMatch[],
  options: Required<ConversationFocusOptions>,
): ConversationMessage[] {
  if (matches.length === 0) {
    return selectRecentConversation(messages, options);
  }

  const prioritized: Array<{ index: number; terms?: string[] }> = [];
  for (const match of matches.slice(0, 6)) {
    prioritized.push({ index: match.index, terms: match.matchedTerms });
    if (messages[match.index - 1]?.role === "user") {
      prioritized.push({ index: match.index - 1 });
    }
    if (messages[match.index + 1]?.role === "user") {
      prioritized.push({ index: match.index + 1 });
    }
    if (messages[match.index + 2]?.role === "assistant") {
      prioritized.push({ index: match.index + 2 });
    }
  }
  for (
    let index = messages.length - 1;
    index >= Math.max(0, messages.length - AUDIT_RECENT_TAIL_MESSAGES);
    index -= 1
  ) {
    prioritized.push({ index });
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    prioritized.push({ index });
  }

  const selected = new Map<number, ConversationMessage>();
  let usedChars = 0;
  for (const candidate of prioritized) {
    if (selected.size >= options.maxMessages || selected.has(candidate.index)) continue;
    const message = messages[candidate.index];
    if (!message) continue;
    const remainingChars = options.maxChars - usedChars;
    if (remainingChars <= 0) break;
    if (message.content.length <= remainingChars) {
      selected.set(candidate.index, message);
      usedChars += message.content.length;
      continue;
    }
    if (candidate.terms && remainingChars >= 80) {
      const clipped = clipAroundClaim(message.content, candidate.terms, remainingChars);
      selected.set(candidate.index, { ...message, content: clipped });
      usedChars += clipped.length;
    }
  }

  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message);
}

function extractPriorClaimTerms(value: string): string[] {
  const cleaned = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:你|您)(?:刚才|之前|前面|先前|上次)?(?:的)?(?:回答|回复|说法|原话|输出|表述)?/g, " ")
    .replace(/(?:说过|说的|提过|提到|写过|写的|回答过|回复过|声称过|输出过)/g, " ")
    .replace(/(?:这个|那个|这些|那些|上述|上面|前面|之前|刚才|自己看看|回头看看)/g, " ")
    .replace(/(?:哪来的?|有没有|是否|是不是|为什么|怎么会|凭什么|不对|错误|错了|幻觉|编造|捏造|矛盾|核对|检查|看看|回看|承认|否认|撤回|纠正)/g, " ")
    .replace(/(?:以及|还有|各种|相关|其中|里面|中的|里边)/g, " ")
    .replace(/\b(?:you|your|said|claim(?:ed)?|wrote|answer(?:ed)?|mention(?:ed)?|response|output|wrong|false|check|verify|deny|contradiction)\b/gi, " ")
    .replace(/[^\p{L}\p{N}+#.-]+/gu, " ");
  const stopTerms = new Set([
    "游戏", "项目", "产品", "系统", "回答", "回复", "内容", "事实", "问题", "东西", "说法", "原话",
    "the", "this", "that", "answer", "response", "assistant", "previous", "earlier",
  ]);
  const terms = new Set<string>();

  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    if (stopTerms.has(token)) continue;
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length >= 2 && token.length <= 12) terms.add(token);
      const maxNgram = Math.min(4, token.length);
      for (let size = 2; size <= maxNgram; size += 1) {
        for (let index = 0; index <= token.length - size; index += 1) {
          const term = token.slice(index, index + size);
          if (!stopTerms.has(term)) terms.add(term);
        }
      }
      continue;
    }
    if (token.length >= 3 && !stopTerms.has(token)) terms.add(token);
  }

  return [...terms].sort((left, right) => right.length - left.length).slice(0, 24);
}

function normalizeForClaimMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.-]+/gu, "");
}

function clipAroundClaim(content: string, terms: string[], maxChars: number): string {
  const normalized = normalizeForClaimMatch(content);
  const term = terms.find((candidate) => normalized.includes(candidate));
  if (!term) return content.slice(-maxChars);

  const compactIndex = normalized.indexOf(term);
  const rawNeedleIndex = content.toLowerCase().indexOf(term);
  const center = rawNeedleIndex >= 0 ? rawNeedleIndex : Math.min(content.length - 1, compactIndex);
  const start = Math.max(0, center - Math.floor(maxChars / 3));
  const end = Math.min(content.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}
