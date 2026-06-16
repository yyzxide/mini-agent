import type { CommandResult } from "../command/CommandRunner.js";
import type { JsonObject } from "../session/SessionTypes.js";
import type { ToolResult } from "../tools/Tool.js";
import type { AgentDecision } from "./AgentDecision.js";

export type AgentStatus = "RUNNING" | "WAITING_USER" | "FINISHED" | "FAILED";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface AgentToolExecutionResult {
  toolName: string;
  input: JsonObject;
  result: ToolResult<unknown>;
}

export interface AgentPatchExecutionResult {
  patch: string;
  description?: string;
  result: ToolResult<unknown>;
}

export interface AgentStateSnapshot {
  sessionId: string;
  repoPath: string;
  userGoal: string;
  step: number;
  maxSteps: number;
  status: AgentStatus;
  messages: AgentMessage[];
  decisions: AgentDecision[];
  toolResults: AgentToolExecutionResult[];
  commandResults: CommandResult[];
  patchResults: AgentPatchExecutionResult[];
  lastError: string | null;
  finalDiff: string | null;
}

export interface AgentStateOptions {
  sessionId: string;
  repoPath: string;
  userGoal: string;
  maxSteps?: number;
}

export class AgentState {
  readonly sessionId: string;
  readonly repoPath: string;
  readonly userGoal: string;
  readonly maxSteps: number;
  step = 0;
  status: AgentStatus = "RUNNING";
  messages: AgentMessage[] = [];
  decisions: AgentDecision[] = [];
  toolResults: AgentToolExecutionResult[] = [];
  commandResults: CommandResult[] = [];
  patchResults: AgentPatchExecutionResult[] = [];
  lastError: string | null = null;
  finalDiff: string | null = null;

  constructor(options: AgentStateOptions) {
    this.sessionId = options.sessionId;
    this.repoPath = options.repoPath;
    this.userGoal = options.userGoal;
    this.maxSteps = options.maxSteps ?? 20;
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: "user", content, timestamp: new Date().toISOString() });
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: "assistant", content, timestamp: new Date().toISOString() });
  }

  addDecision(decision: AgentDecision): void {
    this.decisions.push(decision);
  }

  addToolResult(result: AgentToolExecutionResult): void {
    this.toolResults.push(result);
  }

  addCommandResult(result: CommandResult): void {
    this.commandResults.push(result);
  }

  addPatchResult(result: AgentPatchExecutionResult): void {
    this.patchResults.push(result);
  }

  setLastError(error: string | null): void {
    this.lastError = error;
  }

  incrementStep(): void {
    this.step += 1;
  }

  isStepLimitReached(): boolean {
    return this.step >= this.maxSteps;
  }

  markFinished(finalDiff?: string): void {
    this.status = "FINISHED";
    if (finalDiff !== undefined) {
      this.finalDiff = finalDiff;
    }
  }

  markFailed(error: string): void {
    this.status = "FAILED";
    this.lastError = error;
  }

  toSnapshot(): AgentStateSnapshot {
    return {
      sessionId: this.sessionId,
      repoPath: this.repoPath,
      userGoal: this.userGoal,
      step: this.step,
      maxSteps: this.maxSteps,
      status: this.status,
      messages: [...this.messages],
      decisions: [...this.decisions],
      toolResults: [...this.toolResults],
      commandResults: [...this.commandResults],
      patchResults: [...this.patchResults],
      lastError: this.lastError,
      finalDiff: this.finalDiff,
    };
  }
}
