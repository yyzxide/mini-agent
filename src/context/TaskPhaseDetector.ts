import type { AgentState } from "../agent/AgentState.js";
import type { TaskPhase } from "./ContextTypes.js";

const TARGET_EVIDENCE_TOOLS = new Set(["read_file", "search_code", "knowledge_search"]);

export function detectTaskPhase(state: AgentState): TaskPhase {
  if (state.lastError) {
    return "RECOVERY";
  }

  if (state.patchResults.some((result) => result.result.success) || state.recoveredCheckpoint?.effects.successfulPatch) {
    return "VERIFICATION";
  }

  if (state.toolResults.some((result) => result.result.success && TARGET_EVIDENCE_TOOLS.has(result.toolName))) {
    return "IMPLEMENTATION";
  }

  return "DISCOVERY";
}
