import type { AgentDecision } from "../agent/AgentDecision.js";
import type { AgentStateSnapshot } from "../agent/AgentState.js";
import type { ConversationMessage } from "../session/ConversationHistory.js";

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
  conversation?: ConversationMessage[];
  decisionConstraint?: "FINAL_ONLY";
}

export interface LlmClient {
  chat(input: LlmInput): Promise<AgentDecision>;
  compileTaskFrame?(
    input: TaskFrameCompletionInput,
  ): Promise<TaskFrameCompletionResult>;
}

export interface TaskFrameCompletionInput {
  userGoal: string;
  context?: string;
  conversation?: ConversationMessage[];
}

export interface TaskFrameCompletionResult {
  success: boolean;
  text?: string;
  error?: string;
}
