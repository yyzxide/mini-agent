import {
  classifyProductMetaIntent,
  detectResponseCapabilityDenials,
  inferLocale,
  renderProductCapabilityAnswer,
  type ProductMetaIntent,
} from "./ProductCapability.js";
import type { ProductCapabilityId } from "./CapabilityRegistry.js";

export interface CapabilityTruthCorrection {
  corrected: boolean;
  text: string;
  conflicts: ProductCapabilityId[];
}

/**
 * Product capability claims are checked against the local registry. The model
 * may interpret phrasing, but it cannot override supported=true facts.
 */
export function enforceCapabilityTruth(userGoal: string, answer: string): CapabilityTruthCorrection {
  const conflicts = detectResponseCapabilityDenials(answer);
  if (conflicts.length === 0) {
    return { corrected: false, text: answer, conflicts: [] };
  }

  const classified = classifyProductMetaIntent(userGoal);
  if (!classified || classified.confidence < 0.55) {
    return { corrected: false, text: answer, conflicts };
  }

  const intent = focusIntentOnConflicts(classified, conflicts);
  return {
    corrected: true,
    text: renderProductCapabilityAnswer(intent, { locale: inferLocale(userGoal) }),
    conflicts,
  };
}

function focusIntentOnConflicts(
  intent: ProductMetaIntent,
  conflicts: ProductCapabilityId[],
): ProductMetaIntent {
  if (intent.topic !== "ALL" || conflicts.length !== 1) return intent;
  const conflict = conflicts[0];
  if (conflict !== "WEB_RESEARCH" && conflict !== "REPOSITORY_WRITE") return intent;
  return { ...intent, topic: conflict };
}
