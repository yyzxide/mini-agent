import type { AgentDecision } from "./AgentDecision.js";

export function decisionToMessage(decision: AgentDecision): string {
  switch (decision.type) {
    case "PLAN":
      return decision.message;
    case "TOOL_CALL":
      return decision.reason
        ? `${decision.reason} → ${decision.toolName}`
        : `Calling tool ${decision.toolName}`;
    case "DELEGATE":
    case "DELEGATE_READONLY":
      return `Delegating ${String(decision.tasks.length)} coordinated task(s): ${decision.reason}`;
    case "APPLY_DELEGATED_PATCH":
      return `Applying delegated patch from ${decision.taskId}: ${decision.description}`;
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
