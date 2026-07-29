import type { AgentTaskContract } from "./AgentTaskContract.js";

export type DelegationPreference = "AUTO" | "REQUIRED" | "DISABLED";

export interface TaskCollaborationPolicy {
  preference: DelegationPreference;
  requestedAgents?: number;
  requestsChangeProposal: boolean;
  requestsReview: boolean;
}

/**
 * Resolve collaboration requirements only from the model-compiled TaskFrame.
 * Natural-language interpretation belongs to the semantic compiler, not to a
 * second local intent classifier.
 */
export function resolveTaskCollaborationPolicy(
  contract: AgentTaskContract,
): TaskCollaborationPolicy {
  const frame = contract.taskFrame;
  const collaboration = frame?.collaboration;
  if (!frame || !collaboration) {
    return {
      preference: "AUTO",
      requestsChangeProposal: false,
      requestsReview: false,
    };
  }

  const disabled = frame.constraints.noDelegation;
  return {
    preference: disabled
      ? "DISABLED"
      : collaboration.requirement === "REQUIRED" ? "REQUIRED" : "AUTO",
    ...(collaboration.requestedAgents === null
      ? {}
      : { requestedAgents: collaboration.requestedAgents }),
    requestsChangeProposal: collaboration.changeProposal,
    requestsReview: collaboration.review,
  };
}
