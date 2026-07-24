import { z } from "zod";
import {
  classifyVerificationCommand,
  type VerificationCommandClassification,
} from "../command/CommandClassification.js";
import { buildWorkingSet } from "../context/WorkingSet.js";
import type { JsonObject, SessionRecord } from "../session/SessionTypes.js";
import type { AgentState, AgentStatus, AgentVerificationOutcome } from "./AgentState.js";
import type { AgentOperatingMode } from "./AgentOperatingMode.js";
import type { SubAgentBatchResult } from "./SubAgentTypes.js";
import {
  mergeFileReadCoverageList,
  parseReadFileResultData,
  type FileReadCoverage,
} from "./FileReadCoverage.js";

export const AGENT_CHECKPOINT_VERSION = 1 as const;

export interface AgentCheckpointWorkingSet {
  constraints: string[];
  relevantFiles: string[];
  modifiedFiles: string[];
  completedActions: string[];
  unresolvedQuestions: string[];
  latestFailures: string[];
  verificationStatus: string[];
}

export interface AgentCheckpointEffects {
  successfulPatch: boolean;
  verificationAttemptedAfterPatch?: boolean;
  verificationAfterPatch?: boolean;
  latestVerification?: AgentVerificationOutcome;
  verificationEvidenceAfterPatch?: AgentVerificationOutcome[];
  latestTest?: { command: string; success: boolean; exitCode: number | null };
  knowledgeSearch?: { found: boolean; citations: string[] };
  fileReadCoverage?: FileReadCoverage[];
}

export interface AgentCheckpoint {
  version: 1;
  runId: string;
  userGoal: string;
  operatingMode: AgentOperatingMode;
  status: AgentStatus;
  completedSteps: number;
  totalSteps: number;
  workingSet: AgentCheckpointWorkingSet;
  effects: AgentCheckpointEffects;
  collaboration?: {
    batches: SubAgentBatchResult[];
  };
  lastError?: string;
  inFlightAction?: string;
  recordedAt: string;
}

const workingSetSchema = z.object({
  constraints: z.array(z.string()).max(12),
  relevantFiles: z.array(z.string()).max(20),
  modifiedFiles: z.array(z.string()).max(20),
  completedActions: z.array(z.string()).max(12),
  unresolvedQuestions: z.array(z.string()).max(5),
  latestFailures: z.array(z.string()).max(6),
  verificationStatus: z.array(z.string()).max(4),
}).strict();

const checkpointSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  userGoal: z.string().min(1),
  operatingMode: z.enum(["EXECUTE", "PLAN"]),
  status: z.enum(["RUNNING", "WAITING_USER", "FINISHED", "FAILED"]),
  completedSteps: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  workingSet: workingSetSchema,
  effects: z.object({
    successfulPatch: z.boolean(),
    verificationAttemptedAfterPatch: z.boolean().optional(),
    verificationAfterPatch: z.boolean().optional(),
    latestVerification: z.object({
      command: z.string(),
      success: z.boolean(),
      exitCode: z.number().int().nullable(),
      level: z.enum(["NONE", "DIFF_HYGIENE", "SYNTAX", "STATIC", "TEST"]).optional(),
      repositoryWide: z.boolean().optional(),
      scopePaths: z.array(z.string()).max(20).optional(),
    }).strict().optional(),
    verificationEvidenceAfterPatch: z.array(z.object({
      command: z.string(),
      success: z.boolean(),
      exitCode: z.number().int().nullable(),
      level: z.enum(["NONE", "DIFF_HYGIENE", "SYNTAX", "STATIC", "TEST"]),
      repositoryWide: z.boolean(),
      scopePaths: z.array(z.string()).max(20),
    }).strict()).max(20).optional(),
    latestTest: z.object({
      command: z.string(),
      success: z.boolean(),
      exitCode: z.number().int().nullable(),
    }).strict().optional(),
    knowledgeSearch: z.object({
      found: z.boolean(),
      citations: z.array(z.string()).max(20),
    }).strict().optional(),
    fileReadCoverage: z.array(z.object({
      path: z.string(),
      totalLines: z.number().int().nonnegative(),
      ranges: z.array(z.object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
      }).strict()).max(100),
      complete: z.boolean(),
      nextStartLine: z.number().int().positive().optional(),
      sourceVersion: z.string().optional(),
      partialLine: z.object({
        line: z.number().int().positive(),
        nextColumn: z.number().int().positive(),
      }).strict().optional(),
      readCalls: z.number().int().nonnegative(),
    }).strict()).max(20).optional(),
  }).strict(),
  collaboration: z.object({
    batches: z.array(z.object({
      batchId: z.string(),
      status: z.enum(["COMPLETED", "PARTIAL", "FAILED"]),
      results: z.array(z.object({
        taskId: z.string(),
        role: z.enum(["repository_analyst", "verification_planner", "risk_reviewer", "implementation_agent", "change_reviewer", "general_researcher"]),
        objective: z.string(),
        status: z.enum(["COMPLETED", "FAILED", "BUDGET_EXHAUSTED", "PROTOCOL_VIOLATION"]),
        summary: z.string(),
        evidence: z.array(z.object({
          path: z.string(),
          startLine: z.number().int().optional(),
          endLine: z.number().int().optional(),
        }).strict()),
        toolsCalled: z.array(z.string()),
        proposedPatch: z.string().optional(),
        changedFiles: z.array(z.string()).max(20).optional(),
        reviewedTaskIds: z.array(z.string()).max(3).optional(),
        usage: z.object({
          steps: z.number().int().nonnegative(),
          llmCalls: z.number().int().nonnegative(),
          toolCalls: z.number().int().nonnegative(),
          promptTokens: z.number().int().nonnegative(),
          completionTokens: z.number().int().nonnegative(),
          totalTokens: z.number().int().nonnegative(),
          cachedPromptTokens: z.number().int().nonnegative(),
          reasoningTokens: z.number().int().nonnegative(),
          usageAvailable: z.boolean(),
        }).strict(),
        error: z.string().optional(),
      }).strict()).max(3),
      usage: z.object({
        steps: z.number().int().nonnegative(),
        llmCalls: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        cachedPromptTokens: z.number().int().nonnegative(),
        reasoningTokens: z.number().int().nonnegative(),
        usageAvailable: z.boolean(),
      }).strict(),
      maxParallelAgents: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
    }).strict()).max(2),
  }).strict().optional(),
  lastError: z.string().optional(),
  inFlightAction: z.string().optional(),
  recordedAt: z.string(),
}).strict();

export function createAgentCheckpoint(input: {
  state: AgentState;
  status?: AgentStatus;
  inFlightAction?: string;
}): AgentCheckpoint {
  const { state } = input;
  const workingSet = buildWorkingSet(state);
  const completionEvidence = state.getCompletionEvidence();
  const latestTest = latestCurrentTest(state) ?? state.recoveredCheckpoint?.effects.latestTest;
  const knowledgeSearch = latestCurrentKnowledgeSearch(state) ?? state.recoveredCheckpoint?.effects.knowledgeSearch;
  const baseSteps = state.recoveredCheckpoint?.totalSteps ?? 0;
  return {
    version: AGENT_CHECKPOINT_VERSION,
    runId: state.runId,
    userGoal: state.userGoal,
    operatingMode: state.operatingMode,
    status: input.status ?? state.status,
    completedSteps: state.step,
    totalSteps: baseSteps + state.step,
    workingSet: {
      constraints: workingSet.constraints,
      relevantFiles: workingSet.relevantFiles,
      modifiedFiles: workingSet.modifiedFiles,
      completedActions: workingSet.completedActions,
      unresolvedQuestions: workingSet.unresolvedQuestions,
      latestFailures: workingSet.latestFailures,
      verificationStatus: workingSet.verificationStatus,
    },
    effects: {
      successfulPatch: completionEvidence.repositoryChanged,
      verificationAttemptedAfterPatch: completionEvidence.hasVerificationAfterLatestChange,
      verificationAfterPatch: completionEvidence.verificationAfterLatestChange,
      ...(completionEvidence.latestVerification
        ? { latestVerification: completionEvidence.latestVerification }
        : {}),
      ...(completionEvidence.verificationEvidenceAfterLatestChange.length > 0
        ? { verificationEvidenceAfterPatch: completionEvidence.verificationEvidenceAfterLatestChange }
        : {}),
      ...(latestTest ? { latestTest } : {}),
      ...(knowledgeSearch ? { knowledgeSearch } : {}),
      ...(state.getFileReadCoverage().length > 0
        ? { fileReadCoverage: state.getFileReadCoverage() }
        : {}),
    },
    ...(state.delegationBatches.length > 0
      ? { collaboration: { batches: structuredClone(state.delegationBatches.slice(-2)) } }
      : {}),
    ...(state.lastError ? { lastError: limitText(state.lastError, 2_000) } : {}),
    ...(input.inFlightAction ? { inFlightAction: limitText(input.inFlightAction, 500) } : {}),
    recordedAt: new Date().toISOString(),
  };
}

export function checkpointToPayload(checkpoint: AgentCheckpoint): JsonObject {
  return checkpoint as unknown as JsonObject;
}

export function parseAgentCheckpoint(value: unknown): AgentCheckpoint | undefined {
  const result = checkpointSchema.safeParse(value);
  return result.success ? result.data as AgentCheckpoint : undefined;
}

export function recoverLatestAgentCheckpoint(records: SessionRecord[]): AgentCheckpoint | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || record.type !== "AGENT_CHECKPOINT") continue;
    const checkpoint = parseAgentCheckpoint(record.payload);
    if (!checkpoint) return undefined;
    const tail = records.slice(index + 1);
    const hasLaterSummary = tail.some((candidate) => candidate.type === "TASK_SUMMARY");
    if (hasLaterSummary || checkpoint.status === "FINISHED" || checkpoint.status === "FAILED") return undefined;
    return reconcileCheckpointTail(checkpoint, tail);
  }
  return undefined;
}

export function findLatestAgentCheckpoint(records: SessionRecord[]): AgentCheckpoint | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "AGENT_CHECKPOINT") return parseAgentCheckpoint(record.payload);
  }
  return undefined;
}

function reconcileCheckpointTail(checkpoint: AgentCheckpoint, records: SessionRecord[]): AgentCheckpoint {
  const recovered = structuredClone(checkpoint);
  for (const record of records) {
    if (record.type === "SUBAGENT_BATCH_RESULT") {
      const batch = parseSubAgentBatchResult(record.payload);
      if (batch) {
        recovered.collaboration = {
          batches: [...(recovered.collaboration?.batches ?? []), batch].slice(-2),
        };
      }
      delete recovered.inFlightAction;
      continue;
    }
    if (record.type === "FILE_CHANGE") {
      const files = Array.isArray(record.payload.files)
        ? record.payload.files.flatMap((file) => {
          if (typeof file === "string") return [file];
          if (typeof file === "object" && file !== null && !Array.isArray(file) && typeof file.path === "string") {
            return [file.path];
          }
          return [];
        })
        : [];
      recovered.effects.successfulPatch = true;
      recovered.effects.verificationAttemptedAfterPatch = false;
      recovered.effects.verificationAfterPatch = false;
      recovered.effects.verificationEvidenceAfterPatch = [];
      recovered.workingSet.modifiedFiles = uniqueBounded([...recovered.workingSet.modifiedFiles, ...files], 20);
      recovered.workingSet.relevantFiles = uniqueBounded([...recovered.workingSet.relevantFiles, ...files], 20);
      recovered.workingSet.completedActions = uniqueBounded([...recovered.workingSet.completedActions, "patch:recovered file change"], 12);
      if (files.length > 0 && recovered.effects.fileReadCoverage) {
        const changed = new Set(files.map((file) => file.replaceAll("\\", "/")));
        recovered.effects.fileReadCoverage = recovered.effects.fileReadCoverage
          .filter((entry) => !changed.has(entry.path));
      }
      delete recovered.inFlightAction;
      continue;
    }
    if (record.type === "COMMAND_RESULT") {
      const command = typeof record.payload.command === "string" ? record.payload.command : "";
      const success = record.payload.success === true;
      const exitCode = typeof record.payload.exitCode === "number" ? record.payload.exitCode : null;
      const classification = parsePersistedVerification(record.payload.verification)
        ?? classifyVerificationCommand(command);
      if (command && classification.level !== "NONE") {
        const outcome: AgentVerificationOutcome = {
          command,
          success,
          exitCode,
          level: classification.level,
          repositoryWide: classification.repositoryWide,
          scopePaths: classification.scopePaths,
        };
        recovered.effects.latestVerification = outcome;
        if (recovered.effects.successfulPatch) {
          recovered.effects.verificationAttemptedAfterPatch = true;
          recovered.effects.verificationEvidenceAfterPatch = [
            ...(recovered.effects.verificationEvidenceAfterPatch ?? []),
            outcome,
          ].slice(-20);
          recovered.effects.verificationAfterPatch = recovered.effects.verificationEvidenceAfterPatch
            .some((candidate) => candidate.success);
        }
      }
      if (command && classification.level === "TEST") {
        recovered.effects.latestTest = { command, success, exitCode };
        recovered.workingSet.verificationStatus = uniqueBounded([
          ...recovered.workingSet.verificationStatus,
          `${success ? "PASS" : "FAIL"}: ${command} (exit ${String(exitCode)})`,
        ], 4);
      }
      recovered.workingSet.completedActions = success
        ? uniqueBounded([...recovered.workingSet.completedActions, `command:${command}`], 12)
        : recovered.workingSet.completedActions;
      delete recovered.inFlightAction;
      continue;
    }
    if (record.type === "TOOL_RESULT") {
      const toolName = typeof record.payload.toolName === "string" ? record.payload.toolName : "";
      const success = record.payload.success === true;
      if (success && toolName) {
        recovered.workingSet.completedActions = uniqueBounded([...recovered.workingSet.completedActions, `tool:${toolName}`], 12);
      }
      if (success && toolName === "knowledge_search") {
        const result = record.payload.result;
        if (result && typeof result === "object" && !Array.isArray(result) && typeof result.found === "boolean") {
          recovered.effects.knowledgeSearch = {
            found: result.found,
            citations: Array.isArray(result.citations)
              ? result.citations.filter((citation): citation is string => typeof citation === "string").slice(0, 20)
              : [],
          };
        }
      }
      if (success && toolName === "read_file") {
        const result = parseReadFileResultData(record.payload.result);
        if (result) {
          recovered.effects.fileReadCoverage = mergeFileReadCoverageList(
            recovered.effects.fileReadCoverage ?? [],
            result,
          );
        }
      }
      if (recovered.inFlightAction === `tool:${toolName}`) delete recovered.inFlightAction;
      continue;
    }
    if (record.type === "ERROR") {
      const message = typeof record.payload.message === "string" ? record.payload.message : undefined;
      if (message) {
        recovered.lastError = limitText(message, 2_000);
        recovered.workingSet.latestFailures = uniqueBounded([...recovered.workingSet.latestFailures, recovered.lastError], 6);
      }
    }
  }
  return recovered;
}

function parseSubAgentBatchResult(value: unknown): SubAgentBatchResult | undefined {
  const result = checkpointSchema.shape.collaboration.unwrap().shape.batches.element.safeParse(value);
  return result.success ? result.data as unknown as SubAgentBatchResult : undefined;
}

function uniqueBounded(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(-limit);
}

function latestCurrentTest(state: AgentState): AgentCheckpointEffects["latestTest"] {
  const result = state.commandResults.filter((candidate) => (
    candidate.verification?.level === "TEST"
    || (candidate.verification === undefined && classifyVerificationCommand(candidate.command).level === "TEST")
  )).at(-1);
  return result ? { command: result.command, success: result.success, exitCode: result.exitCode } : undefined;
}

function parsePersistedVerification(value: unknown): VerificationCommandClassification | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const levels = new Set(["NONE", "DIFF_HYGIENE", "SYNTAX", "STATIC", "TEST"]);
  const categories = new Set(["none", "diff_hygiene", "syntax", "static", "test"]);
  if (
    typeof record.level !== "string"
    || !levels.has(record.level)
    || typeof record.category !== "string"
    || !categories.has(record.category)
    || typeof record.repositoryWide !== "boolean"
    || !Array.isArray(record.scopePaths)
    || !record.scopePaths.every((path) => typeof path === "string")
  ) {
    return undefined;
  }
  return {
    level: record.level as VerificationCommandClassification["level"],
    category: record.category as VerificationCommandClassification["category"],
    repositoryWide: record.repositoryWide,
    scopePaths: record.scopePaths.slice(0, 20) as string[],
  };
}

function latestCurrentKnowledgeSearch(state: AgentState): AgentCheckpointEffects["knowledgeSearch"] {
  for (const toolResult of [...state.toolResults].reverse()) {
    if (toolResult.toolName !== "knowledge_search" || !toolResult.result.success) continue;
    const data = toolResult.result.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || !("found" in data)) continue;
    const found = (data as { found?: unknown }).found;
    if (typeof found !== "boolean") continue;
    const citations = "citations" in data ? (data as { citations?: unknown }).citations : undefined;
    return {
      found,
      citations: Array.isArray(citations)
        ? citations.filter((citation): citation is string => typeof citation === "string").slice(0, 20)
        : [],
    };
  }
  return undefined;
}

function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...[truncated]`;
}
