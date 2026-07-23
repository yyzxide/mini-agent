import type { AgentDecision } from "../agent/AgentDecision.js";
import type { ArtifactFollowUpIntent } from "../agent/ArtifactFollowUp.js";
import type { ContextTrace } from "../context/ContextTypes.js";
import type { ConversationSelectionStrategy } from "../session/ConversationHistory.js";
import type { JsonObject } from "../session/SessionTypes.js";

export type RuntimeVerbosity = "normal" | "verbose" | "trace";

export interface RuntimeEventMetadata {
  version?: 1;
  timestamp?: string;
  sequence?: number;
  sessionId?: string;
  runId?: string;
  step?: number;
}

export interface RuntimeLlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usageAvailable: boolean;
}

export interface RuntimeConversationTrace {
  totalMessages: number;
  selectedMessages: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  truncated: boolean;
  focusedOnLatestTurn: boolean;
  selectionStrategy: ConversationSelectionStrategy;
  matchedAssistantMessages: number;
  roles: Array<"user" | "assistant">;
}

export type AgentRuntimeEvent = RuntimeEventMetadata & (
  | { type: "session"; sessionId: string }
  | {
    type: "follow_up";
    intent: ArtifactFollowUpIntent;
    source: "FILE_CHANGE";
    files: string[];
    llmSkipped: boolean;
  }
  | { type: "conversation"; trace: RuntimeConversationTrace }
  | { type: "decision"; decisionType: AgentDecision["type"]; message: string; decision?: AgentDecision }
  | { type: "plan"; message: string }
  | { type: "context"; trace: ContextTrace }
  | {
    type: "llm";
    phase: "started" | "finished" | "failed";
    mode: string;
    model?: string;
    calls?: number;
    durationMs?: number;
    finishReason?: string;
    usage?: RuntimeLlmUsage;
    error?: string;
  }
  | { type: "tool"; toolName: string; input: JsonObject }
  | { type: "tool_result"; toolName: string; success: boolean; durationMs: number; summary?: string; resultPreview?: string; error?: string }
  | { type: "agents"; phase: "started" | "finished" | "failed"; tasks: number; message: string }
  | { type: "patch"; description: string }
  | { type: "patch_result"; success: boolean; durationMs: number; description: string; error?: string }
  | { type: "command"; command: string; description?: string; cwd?: string }
  | { type: "command_output"; stream: "stdout" | "stderr"; chunk: string }
  | {
    type: "command_result";
    command: string;
    success: boolean;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  }
  | { type: "cache"; cache: "embedding"; memoryHits: number; diskHits: number; misses: number; writes: number; coalescedRequests: number }
  | { type: "guardrail"; code: string; message: string }
  | { type: "ask_user"; message: string }
  | { type: "diff"; generated: boolean }
  | { type: "summary"; summary: string; success: boolean }
  | { type: "error"; message: string }
);

export type AgentRuntimeEventHandler = (event: AgentRuntimeEvent) => void | Promise<void>;
