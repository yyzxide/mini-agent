import {
  inferLocale,
  renderProductCapabilityAnswer,
} from "./ProductCapability.js";
import type { ProductCapabilityId } from "./CapabilityRegistry.js";
import type { TaskFrame } from "../runtime/TaskFrame.js";

export interface CapabilityTruthCorrection {
  corrected: boolean;
  text: string;
  capabilities: ProductCapabilityId[];
}

/**
 * Product capability answers are rendered from model-selected semantic IDs and
 * the local registry. Raw user or assistant wording is deliberately not
 * rescanned here, so adding a new phrasing never requires another regex route.
 */
export function enforceCapabilityTruth(input: {
  taskFrame?: TaskFrame;
  userGoal: string;
  answer: string;
}): CapabilityTruthCorrection {
  const frame = input.taskFrame;
  const productRequest = frame?.target === "PRODUCT"
    || (frame?.target === "MIXED"
      && frame.conversationEvidence.purpose === "PRIOR_RESPONSE_AUDIT");
  const intent = frame?.productCapability;
  if (!productRequest || !intent || intent.act === "NONE") {
    return { corrected: false, text: input.answer, capabilities: [] };
  }

  const priorResponseAudit = frame.conversationEvidence.purpose === "PRIOR_RESPONSE_AUDIT";
  return {
    corrected: true,
    text: renderProductCapabilityAnswer(intent, {
      priorDenialFound: priorResponseAudit,
      locale: inferLocale(input.userGoal),
    }),
    capabilities: intent.capabilityIds,
  };
}
