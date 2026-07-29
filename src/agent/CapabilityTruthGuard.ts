import {
  detectResponseCapabilityDenials,
  inferLocale,
  renderProductCapabilityAnswer,
  type ProductMetaTopic,
} from "./ProductCapability.js";
import type { ProductCapabilityId } from "./CapabilityRegistry.js";
import type { TaskFrame } from "../runtime/TaskFrame.js";

export interface CapabilityTruthCorrection {
  corrected: boolean;
  text: string;
  conflicts: ProductCapabilityId[];
}

/**
 * Product capability claims are checked against the local registry. The model
 * may interpret phrasing, but it cannot override supported=true facts.
 */
export function enforceCapabilityTruth(input: {
  taskFrame?: TaskFrame;
  userGoal: string;
  answer: string;
}): CapabilityTruthCorrection {
  const conflicts = detectResponseCapabilityDenials(input.answer);
  if (conflicts.length === 0) {
    return { corrected: false, text: input.answer, conflicts: [] };
  }

  const frame = input.taskFrame;
  const semanticProductRequest = frame?.target === "PRODUCT"
    || (frame?.target === "MIXED"
      && frame.conversationEvidence.purpose === "PRIOR_RESPONSE_AUDIT");
  if (!semanticProductRequest) {
    return { corrected: false, text: input.answer, conflicts };
  }

  const priorResponseAudit = frame.conversationEvidence.purpose === "PRIOR_RESPONSE_AUDIT";
  return {
    corrected: true,
    text: renderProductCapabilityAnswer(
      {
        topic: topicForConflicts(conflicts),
        act: priorResponseAudit ? "EXPLAIN_LIMITATION" : "AVAILABILITY",
      },
      {
        priorDenialFound: priorResponseAudit,
        locale: inferLocale(input.userGoal),
      },
    ),
    conflicts,
  };
}

function topicForConflicts(
  conflicts: ProductCapabilityId[],
): ProductMetaTopic {
  if (conflicts.length !== 1) return "ALL";
  const conflict = conflicts[0];
  if (
    conflict === "WEB_RESEARCH"
    || conflict === "REPOSITORY_WRITE"
    || conflict === "MULTI_AGENT_COLLABORATION"
  ) {
    return conflict;
  }
  return "ALL";
}
