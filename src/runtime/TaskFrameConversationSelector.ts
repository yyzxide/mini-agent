import type { ConversationMessage } from "../session/ConversationHistory.js";
import type { TaskFrame } from "./TaskFrame.js";

export interface TaskFrameConversationSelection {
  messages: ConversationMessage[];
  matchedAssistantMessages: number;
  semanticMatches: number;
}

interface RankedMessage {
  index: number;
  priority: number;
  semanticMatch: boolean;
}

const MAX_SELECTED_MESSAGES = 16;
const MAX_SELECTED_CHARS = 12_000;
const MAX_SEMANTIC_MATCHES = 8;

/**
 * Selects bounded conversation evidence from model-authored semantic queries.
 * Matching is domain-neutral: no dialogue-act or task-specific regex decides
 * which history is relevant.
 */
export function selectTaskFrameConversation(input: {
  messages: ConversationMessage[];
  frame: TaskFrame;
}): TaskFrameConversationSelection {
  const recentCount = input.frame.conversationEvidence.includeRecentMessages;
  const recentStart = Math.max(0, input.messages.length - recentCount);
  const ranked = new Map<number, RankedMessage>();

  for (let index = recentStart; index < input.messages.length; index += 1) {
    ranked.set(index, {
      index,
      priority: 10_000 + index,
      semanticMatch: false,
    });
  }

  const queries = input.frame.conversationEvidence.queries.length > 0
    ? input.frame.conversationEvidence.queries
    : input.frame.conversationEvidence.requiresHistory
      ? [input.frame.objective]
      : [];
  const semantic = input.messages
    .map((message, index) => ({
      index,
      score: index < recentStart ? scoreMessage(message.content, queries) : 0,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_SEMANTIC_MATCHES);

  for (const match of semantic) {
    addRanked(ranked, match.index, 20_000 + match.score, true);
    addRanked(ranked, match.index - 1, 5_000 + match.score, false, input.messages.length);
    addRanked(ranked, match.index + 1, 5_000 + match.score, false, input.messages.length);
  }

  const selected = [...ranked.values()]
    .sort((left, right) => right.priority - left.priority || right.index - left.index)
    .slice(0, MAX_SELECTED_MESSAGES);
  const fitted: RankedMessage[] = [];
  let remainingChars = MAX_SELECTED_CHARS;
  for (const candidate of selected) {
    const message = input.messages[candidate.index];
    if (!message || remainingChars <= 0) continue;
    if (message.content.length > remainingChars && fitted.length > 0) continue;
    fitted.push(candidate);
    remainingChars -= Math.min(message.content.length, remainingChars);
  }
  fitted.sort((left, right) => left.index - right.index);

  return {
    messages: fitted.map((candidate) => {
      const message = input.messages[candidate.index]!;
      return message.content.length <= MAX_SELECTED_CHARS
        ? message
        : { ...message, content: message.content.slice(-MAX_SELECTED_CHARS) };
    }),
    matchedAssistantMessages: fitted.filter((candidate) =>
      candidate.semanticMatch && input.messages[candidate.index]?.role === "assistant",
    ).length,
    semanticMatches: fitted.filter((candidate) => candidate.semanticMatch).length,
  };
}

function addRanked(
  ranked: Map<number, RankedMessage>,
  index: number,
  priority: number,
  semanticMatch: boolean,
  messageCount = Number.MAX_SAFE_INTEGER,
): void {
  if (index < 0 || index >= messageCount) return;
  const existing = ranked.get(index);
  if (!existing || priority > existing.priority) {
    ranked.set(index, { index, priority, semanticMatch: semanticMatch || existing?.semanticMatch === true });
  } else if (semanticMatch && !existing.semanticMatch) {
    ranked.set(index, { ...existing, semanticMatch: true });
  }
}

function scoreMessage(content: string, queries: string[]): number {
  const normalizedContent = normalize(content);
  let score = 0;
  for (const query of queries) {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) continue;
    if (normalizedContent.includes(normalizedQuery)) {
      score += 100 + Math.min(100, normalizedQuery.length);
    }
    for (const term of extractTerms(normalizedQuery)) {
      if (normalizedContent.includes(term)) score += Math.min(24, term.length * 3);
    }
  }
  return score;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function extractTerms(value: string): string[] {
  const terms = new Set<string>();
  for (const token of value.match(/[a-z0-9_./-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    terms.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 4) {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}
