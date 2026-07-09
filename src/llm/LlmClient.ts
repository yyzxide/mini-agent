import type { AgentDecision } from "../agent/AgentDecision.js";
import type { AgentStateSnapshot } from "../agent/AgentState.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  permissionLevel: string;
  source?: "local" | "mcp";
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface LlmInput {
  userGoal: string;
  context: string;
  state: AgentStateSnapshot;
  availableTools: ToolSpec[];
}

export interface LlmClient {
  chat(input: LlmInput): Promise<AgentDecision>;
}
