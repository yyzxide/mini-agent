import { planMemoryRead, type MemoryReadPlan } from "./MemoryPolicy.js";

export interface DirectAnswerMemoryPlanInput {
  userGoal: string;
  resolvedFollowUpGoal?: string;
  hasRecentConversation: boolean;
}

export type DirectAnswerMemoryPlan = MemoryReadPlan;

/** Ordinary direct answers rely on current conversation state. Historical
 * memory is selected only when the user explicitly asks for prior work. */
export function planDirectAnswerMemory(input: DirectAnswerMemoryPlanInput): DirectAnswerMemoryPlan {
  return planMemoryRead({
    mode: "DIRECT_ANSWER",
    query: input.userGoal,
    ...(input.resolvedFollowUpGoal ? { resolvedQuery: input.resolvedFollowUpGoal } : {}),
  });
}
