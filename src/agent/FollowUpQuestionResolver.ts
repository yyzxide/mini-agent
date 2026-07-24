import type { ConversationMessage } from "../session/ConversationHistory.js";
import {
  findLatestUserMessage,
  isPriorResponseAuditRequest,
} from "../session/ConversationHistory.js";

export function extractLastUserMessage(sessionMemory: string): string | undefined {
  const matches = [...sessionMemory.matchAll(/^\[user\]\s+(.+)$/gm)];
  const latest = matches.at(-1)?.[1]?.trim();
  return latest && latest !== "(none)" ? latest : undefined;
}

export function resolveFollowUpQuestion(
  userGoal: string,
  conversation: string | ConversationMessage[],
): string | undefined {
  if (isPriorResponseAuditRequest(userGoal)) return undefined;
  const previousUserMessage = typeof conversation === "string"
    ? extractLastUserMessage(conversation)
    : findLatestUserMessage(conversation);
  return previousUserMessage
    ? expandShortFollowUpQuestion(userGoal, previousUserMessage)
    : undefined;
}

export function isShortFollowUpQuestion(value: string): boolean {
  const normalized = normalizeSpaces(value);
  if (normalized.length === 0 || normalized.length > 24) return false;
  if (isPriorResponseAuditRequest(normalized)) return false;
  if (/^(那|那么|那如果|那要是|那对于|还有|然后)/.test(normalized)) return true;
  if (/(呢|咋样|怎么样|如何)([？?]?)$/.test(normalized)) return true;
  return normalized.length <= 8;
}

export function expandShortFollowUpQuestion(
  currentGoal: string,
  previousUserMessage: string,
): string | undefined {
  const current = normalizeSpaces(currentGoal);
  const previous = normalizeSpaces(previousUserMessage);
  if (!isShortFollowUpQuestion(current) || previous.length === 0) return undefined;
  const subject = extractFollowUpSubject(current);
  const predicate = extractFollowUpPredicate(previous);
  return subject && predicate ? normalizeSpaces(`${subject}${predicate}`) : undefined;
}

function extractFollowUpSubject(value: string): string | undefined {
  const normalized = normalizeSpaces(value)
    .replace(/^(那|那么|那如果|那要是|那对于|还有|然后)/, "")
    .replace(/(呢|咋样|怎么样|如何)([？?]?)$/, "")
    .replace(/[？?]+$/, "")
    .trim();
  return normalized || undefined;
}

function extractFollowUpPredicate(previousUserMessage: string): string | undefined {
  const normalized = normalizeSpaces(previousUserMessage).replace(/[？?]+$/, "");
  const markerPatterns = [
    /^(?:.+?)((?:有多少|有几个|有哪些|哪几个|哪一些).+)$/,
    /^(?:.+?)(的.{1,30}(?:是什么|是谁|在哪里|位于哪里|有多少|有哪些))$/,
    /^(?:.+?)(是(?!什么|谁).+)$/,
  ];
  for (const pattern of markerPatterns) {
    const candidate = normalized.match(pattern)?.[1];
    if (candidate?.trim()) return normalizeSpaces(candidate);
  }
  return undefined;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
