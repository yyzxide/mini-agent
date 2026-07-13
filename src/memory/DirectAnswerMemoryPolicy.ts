import { buildMemoryQuery } from "./MemoryQueryBuilder.js";

export interface DirectAnswerMemoryPlanInput {
  userGoal: string;
  resolvedFollowUpGoal?: string;
  hasRecentConversation: boolean;
}

export interface DirectAnswerMemoryPlan {
  retrieve: boolean;
  query: string;
}

/**
 * Long-term retrieval is useful for standalone questions and explicit recall,
 * but unsafe as an automatic topic selector during an active conversation.
 * A deterministically grounded follow-up is also safe because its query already
 * contains the omitted topic or predicate.
 */
export function planDirectAnswerMemory(input: DirectAnswerMemoryPlanInput): DirectAnswerMemoryPlan {
  const query = input.resolvedFollowUpGoal ?? input.userGoal;
  if (!input.hasRecentConversation) {
    return { retrieve: true, query };
  }
  if (input.resolvedFollowUpGoal && input.resolvedFollowUpGoal !== input.userGoal) {
    return { retrieve: true, query };
  }

  const memoryQuery = buildMemoryQuery({ query: input.userGoal });
  return {
    retrieve: memoryQuery.intent === "CONVERSATION",
    query,
  };
}
