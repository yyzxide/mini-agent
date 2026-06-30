import type { AgentDecision } from "./AgentDecision.js";

export function decisionToMessage(decision: AgentDecision): string {
  switch (decision.type) {
    case "PLAN":
      return decision.message;
    case "TOOL_CALL":
      return `Calling tool ${decision.toolName}`;
    case "APPLY_PATCH":
      return decision.description ?? "Applying patch";
    case "RUN_COMMAND":
      return decision.description ?? `Running command: ${decision.shell ? decision.command : decision.executable}`;
    case "ASK_USER":
      return decision.message;
    case "FINAL":
      return decision.summary;
    case "FAILED":
      return decision.error;
  }
}
