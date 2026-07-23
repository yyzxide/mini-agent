import {
  findPriorAssistantClaimMatches,
  isPriorResponseAuditRequest,
  type ConversationMessage,
  type PriorAssistantClaimMatch,
} from "../session/ConversationHistory.js";

export type PriorResponseConsistencyCode =
  | "PRIOR_RESPONSE_DENIAL"
  | "INSUFFICIENT_HISTORY_FOR_DENIAL";

export interface PriorResponseConsistencyViolation {
  code: PriorResponseConsistencyCode;
  excerpt?: string;
  matchedTerms: string[];
}

export interface PriorResponseTruthGuardOptions {
  historyTruncated?: boolean;
}

/**
 * Checks only a fact the runtime can know deterministically: whether the draft
 * denies a prior output that is visible in the conversation record. It does not
 * attempt to judge whether the external-world claim itself is true.
 */
export function inspectPriorResponseConsistency(
  userGoal: string,
  draft: string,
  conversation: ConversationMessage[],
  options: PriorResponseTruthGuardOptions = {},
): PriorResponseConsistencyViolation | undefined {
  if (!isPriorResponseAuditRequest(userGoal) || !containsPriorOutputDenial(draft)) {
    return undefined;
  }
  if (containsPriorOutputAcknowledgement(draft)) {
    return undefined;
  }

  const matches = findPriorAssistantClaimMatches(conversation, userGoal);
  const bestMatch = matches[0];
  if (bestMatch) {
    return {
      code: "PRIOR_RESPONSE_DENIAL",
      excerpt: excerptFromMatch(bestMatch),
      matchedTerms: bestMatch.matchedTerms,
    };
  }
  if (options.historyTruncated) {
    return {
      code: "INSUFFICIENT_HISTORY_FOR_DENIAL",
      matchedTerms: [],
    };
  }
  return undefined;
}

export function buildPriorResponseRevisionContext(
  violation: PriorResponseConsistencyViolation,
  rejectedDraft: string,
): string {
  const evidence = violation.excerpt
    ? `Visible earlier assistant output:\n${violation.excerpt}`
    : "The available conversation selection is incomplete, so absence from it cannot prove that no earlier statement exists.";
  return [
    "Conversation consistency revision required:",
    evidence,
    "Revise the answer once. Distinguish these two questions: (1) what the conversation record proves you previously output, and (2) whether that external claim is actually true.",
    "Do not deny, minimize, or rewrite a visible earlier statement. If external evidence is unavailable, retract the unverified claim and state the uncertainty without inventing replacement details.",
    "",
    "Rejected first draft:",
    rejectedDraft.slice(0, 2_000),
  ].join("\n");
}

export function renderPriorResponseSafeFallback(
  violation: PriorResponseConsistencyViolation,
  locale: "zh" | "en",
): string {
  if (locale === "en") {
    if (!violation.excerpt) {
      return "The visible conversation context is incomplete, so I cannot truthfully claim that I never said that. I should inspect the original record before making a denial; without reliable external evidence, I also should not invent a replacement factual answer.";
    }
    return `The visible conversation record contains this relevant earlier output from me: “${violation.excerpt}” Therefore I cannot broadly claim that I never said it or rewrite what the text said. The record proves only that I produced the text, not that the external claim was true; without reliable evidence, I should retract the unverified part instead of adding new details.`;
  }

  if (!violation.excerpt) {
    return "当前可见的会话记录并不完整，所以我不能断言“我之前没说过”。正确做法是先核对原始记录；在没有可靠外部证据时，也不能再编一个新的事实答案来替换它。";
  }
  return `当前可见会话记录里，确实存在我此前输出的相关原文：“${violation.excerpt}” 因此我不能笼统地说“我没说过”，也不能重新解释原话来回避它。会话记录只能证明这段文字出现过，不能证明其中的外部事实正确；在缺少可靠证据时，我应该撤回未核验部分，而不是继续补充新细节。`;
}

export function inferPriorResponseLocale(value: string): "zh" | "en" {
  return /[\p{Script=Han}]/u.test(value) ? "zh" : "en";
}

function containsPriorOutputDenial(value: string): boolean {
  return [
    /(?:我|此前|之前|刚才|前面).{0,12}(?:没有|没|并未|从未)(?:明确)?(?:说过|说|提过|提到|写过|写|输出过|声称过)/i,
    /(?:我|此前|之前|刚才|前面).{0,12}(?:并不是|不是|并非)(?:在)?(?:说|声称|表示)/i,
    /(?:并不是|不是|并非)(?:在)?说.{0,24}(?:而是|只是|指的是)/i,
    /(?:之前|此前|刚才|前面).{0,8}(?:我)?(?:说|提到|写).{0,120}(?:指的是|意思是|只是).{0,80}(?:不是|并非|而不是)/i,
    /\bI\s+(?:did\s+not|didn't|never)\s+(?:say|claim|write|mention|state|output)\b/i,
    /\bwhat\s+I\s+(?:said|meant)\s+was\b.{0,80}\bnot\b/i,
  ].some((pattern) => pattern.test(value));
}

function containsPriorOutputAcknowledgement(value: string): boolean {
  return [
    /(?:我)?(?:确实|的确|承认).{0,16}(?:说过|提过|写过|输出过|声称过|回答过)/i,
    /(?:我之前|我刚才|此前|前面)(?:确实|的确)?(?:说错|写错|答错|输出过|说过).{0,12}(?:撤回|错误|不对|无依据|未核验)?/i,
    /\bI\s+(?:did|do)\s+(?:indeed\s+)?(?:say|claim|write|mention|state|output)\b/i,
    /\bI\s+(?:was|am)\s+wrong\b/i,
  ].some((pattern) => pattern.test(value));
}

function excerptFromMatch(match: PriorAssistantClaimMatch): string {
  const content = match.content.replace(/\s+/g, " ").trim();
  const rawTerm = match.matchedTerms.find((term) => content.toLowerCase().includes(term));
  const center = rawTerm ? content.toLowerCase().indexOf(rawTerm) : 0;
  const maxChars = 280;
  const start = Math.max(0, center - 80);
  const end = Math.min(content.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}
