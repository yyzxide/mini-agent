import {
  isPriorResponseAuditRequest,
  type ConversationMessage,
} from "../session/ConversationHistory.js";
import { classifyExternalFactPolicy } from "./ExternalFactPolicy.js";
import { understandTask, type TaskUnderstanding } from "./TaskUnderstanding.js";

export type EvidenceRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface EvidenceRiskAssessment {
  level: EvidenceRiskLevel;
  requiresVerification: boolean;
  signals: string[];
  reason: string;
}

export interface AssessEvidenceRiskInput {
  userGoal: string;
  draft: string;
  conversation?: ConversationMessage[];
  now?: Date;
  understanding?: TaskUnderstanding;
}

/**
 * Audits the concrete claims a Direct draft is about to publish. The existing
 * request classifier is one input, not a capability gate: missed or ambiguous
 * request wording can still be escalated from draft claims and conversation
 * risk before the answer leaves AgentLoop.
 */
export function assessEvidenceRisk(input: AssessEvidenceRiskInput): EvidenceRiskAssessment {
  const goal = normalize(input.userGoal);
  const draft = normalize(input.draft);
  const requestPolicy = classifyExternalFactPolicy(input.userGoal);
  const understanding = input.understanding ?? understandTask(input.userGoal);
  const signals: string[] = [];

  if (looksLikeLocalAssistantIdentityQuestion(goal)) {
    return {
      level: "LOW",
      requiresVerification: false,
      signals: ["product-identity"],
      reason: "The request asks for the local assistant's identity, which is product metadata rather than an external-world identity claim.",
    };
  }

  const locallyGrounded = requestPolicy.policy === "NOT_EXTERNAL_FACT"
    && requestPolicy.signals.some((signal) => [
      "product-meta",
      "repository-or-coding-task",
      "derivable-reasoning",
      "conversation-record",
    ].includes(signal));
  if (locallyGrounded) {
    return {
      level: "LOW",
      requiresVerification: false,
      signals: requestPolicy.signals,
      reason: "The request is grounded in local state, derivation, creation, or product metadata rather than an external-world claim.",
    };
  }
  if (isPriorResponseAuditRequest(input.userGoal) && isRetractionOrUncertaintyDraft(draft)) {
    return {
      level: "LOW",
      requiresVerification: false,
      signals: ["prior-response-retraction"],
      reason: "The draft acknowledges or retracts an earlier unsupported claim instead of publishing it as a verified external fact.",
    };
  }

  if (requestPolicy.policy === "VERIFICATION_REQUIRED") {
    signals.push(...requestPolicy.signals, "request-policy-high-risk");
  }
  if (
    understanding.target === "WORLD"
    && understanding.externalFactPolicy === "VERIFICATION_REQUIRED"
    && ["RELATION", "IDENTITY", "COUNT"].includes(understanding.answerShape)
  ) {
    signals.push("bounded-relation");
  }
  if (containsExactClaimMarkers(draft)) {
    signals.push("draft-exact-claim");
  }
  if (containsStrongNegativeOrUniversalClaim(draft)) {
    signals.push("draft-strong-negative-or-universal");
  }
  if (containsVolatileStatusClaim(draft)) {
    signals.push("draft-temporal-status");
  }
  if (hasPastScheduleContradiction(draft, input.now ?? new Date())) {
    signals.push("runtime-date-contradiction");
  }
  if (hasRecentFactualCorrection(input.conversation ?? [])) {
    signals.push("recent-factual-correction");
  }

  const uniqueSignals = [...new Set(signals)];
  const requiresVerification = (
    uniqueSignals.includes("request-policy-high-risk")
    || uniqueSignals.includes("runtime-date-contradiction")
    || uniqueSignals.includes("bounded-relation")
    || (
      uniqueSignals.includes("recent-factual-correction")
      && (
        uniqueSignals.includes("draft-exact-claim")
        || uniqueSignals.includes("draft-temporal-status")
        || uniqueSignals.includes("draft-strong-negative-or-universal")
      )
    )
  );

  if (requiresVerification) {
    return {
      level: "HIGH",
      requiresVerification: true,
      signals: uniqueSignals,
      reason: "The draft makes a bounded, precise, temporal, contradicted, or recently corrected external-world claim without current run evidence.",
    };
  }

  if (uniqueSignals.length > 0) {
    return {
      level: "MEDIUM",
      requiresVerification: false,
      signals: uniqueSignals,
      reason: "The draft contains factual detail, but the request remains suitable for calibrated general knowledge unless stronger evidence risk appears.",
    };
  }

  return {
    level: "LOW",
    requiresVerification: false,
    signals: [],
    reason: "No precise, volatile, exhaustive, contradicted, or correction-sensitive external claim was detected.",
  };
}

function containsExactClaimMarkers(value: string): boolean {
  return /(?:\b(?:19|20)\d{2}\b|\d+(?:\.\d+)+(?:[-\w]*)?|\b\d+\s*(?:个|位|种|项|部|名|%|美元|元|km|kg|gb|tb)\b|第\s*(?:\d+|[一二三四五六七八九十百两]+)\s*(?:章|关|幕|季|集|部|卷|任|届|次|个|位))|(?:发布|发售|上线|下线|成立|出生|位于|获得|掉落|包含|支持|使用)/i.test(value);
}

function containsStrongNegativeOrUniversalClaim(value: string): boolean {
  return /(?:没有任何|没有.{0,12}(?:已确认|可靠|官方)(?:的)?(?:信息|证据|内容|说法)?|从未|绝不|均属于|全部都是|唯一(?:的)?|官方至今没有|无法确认|不存在|尚未公布)|\b(?:no official|none of|never|all of them|the only|does not exist|cannot be confirmed)\b/i.test(value);
}

function containsVolatileStatusClaim(value: string): boolean {
  return /(?:目前|当前|现在|至今|尚未|还未|已经|仍然|计划|预计).{0,24}(?:发布|发售|上线|开放|公布|提供|支持|担任|在售|可用)|\b(?:currently|as of|still|not yet|already|scheduled|planned|expected)\b.{0,40}\b(?:release|launch|available|open|support|serve|sell)\b/i.test(value);
}

function hasPastScheduleContradiction(value: string, now: Date): boolean {
  if (!/(?:尚未|还未|未正式|not yet|has not yet).{0,60}(?:计划|预计|scheduled|planned|expected)|(?:计划|预计|scheduled|planned|expected).{0,60}(?:尚未|还未|未正式|not yet|has not yet)/i.test(value)) {
    return false;
  }
  const years = [...value.matchAll(/\b((?:19|20)\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return years.some((year) => year < now.getFullYear());
}

function hasRecentFactualCorrection(conversation: ConversationMessage[]): boolean {
  return conversation.slice(-6).some((message) => {
    const text = normalize(message.content);
    if (message.role === "user") {
      return /(?:骗我|编的|瞎编|胡说|错了|不对|不准确|幻觉|真的吗|核实一下)|\b(?:lying|made up|fabricated|wrong|incorrect|hallucinat|verify that)\b/i.test(text);
    }
    return /(?:我承认.{0,12}(?:错误|有问题)|随口编|记忆有误|没有核实|未经核实|不够可靠|我撤回|确实犯了错误)|\b(?:i (?:admit|was wrong)|made (?:that|it) up|memory was wrong|did not verify|unverified|i retract)\b/i.test(text);
  });
}

function isRetractionOrUncertaintyDraft(value: string): boolean {
  return /(?:我.{0,16}(?:承认|说过|提到|回答).{0,20}(?:错误|有误|没有依据|没有证据|未经核实)|(?:这条|这个|上述|此前).{0,16}(?:说法|回答|内容).{0,16}(?:没有依据|没有证据|未经核实|不可靠)|我撤回|不再补充未经核验)|\b(?:i (?:admit|acknowledge).{0,30}(?:wrong|error|unverified)|i (?:retract|withdraw)|that (?:claim|answer).{0,20}(?:unverified|unsupported|unreliable))\b/i.test(value);
}

function looksLikeLocalAssistantIdentityQuestion(value: string): boolean {
  return /^(?:(?:请问|那么|那|所以)\s*)?(?:你|你们|这个(?:助手|agent|cli)|mini[- ]?(?:agent|coding agent))\s*(?:到底|究竟)?\s*(?:是谁|叫什么|是什么(?:助手|agent|cli)?)(?:[？?。！!]|$)|\b(?:who are you|what are you|what is your name)\b/i.test(value);
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
