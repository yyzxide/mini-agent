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
}

export interface LlmClient {
  chat(input: LlmInput): Promise<AgentDecision>;
  completeText?(input: LlmTextCompletionInput): Promise<LlmTextCompletionResult>;
}

export interface LlmTextCompletionInput {
  userGoal: string;
  context?: string;
  conversation?: ConversationMessage[];
  mode?: "direct" | "web" | "web_rewrite";
}

export interface LlmTextCompletionResult {
  success: boolean;
  text?: string;
  error?: string;
}
