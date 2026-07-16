export type TaskPhase = "DISCOVERY" | "IMPLEMENTATION" | "VERIFICATION" | "RECOVERY";

export type ContextRetention = "head" | "tail" | "head_tail";

export interface WorkingSet {
  goal: string;
  phase: TaskPhase;
  constraints: string[];
  relevantFiles: string[];
  modifiedFiles: string[];
  completedActions: string[];
  unresolvedQuestions: string[];
  latestFailures: string[];
  verificationStatus: string[];
}

export interface ContextSectionCandidate {
  id: string;
  title: string;
  content: string;
  priority: number;
  reason: string;
  enabled?: boolean;
  required?: boolean;
  stable?: boolean;
  minTokens?: number;
  maxTokens?: number;
  retention?: ContextRetention;
}

export interface ContextSectionTrace {
  id: string;
  title: string;
  priority: number;
  required: boolean;
  stable: boolean;
  selected: boolean;
  truncated: boolean;
  estimatedTokens: number;
  includedTokens: number;
  includedChars: number;
  reason: string;
}

export interface ContextTrace {
  version: 2;
  phase: TaskPhase;
  maxChars: number;
  maxTokens: number;
  totalChars: number;
  totalEstimatedTokens: number;
  sections: ContextSectionTrace[];
}

export interface ContextPlan {
  context: string;
  trace: ContextTrace;
}
