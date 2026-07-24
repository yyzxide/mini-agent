import type { CommandResult } from "../command/CommandRunner.js";
import { extractChangedPathsFromUnifiedDiff } from "../diff/ChangedPaths.js";
import type { JsonObject } from "../session/SessionTypes.js";
import type { ToolResult } from "../tools/Tool.js";
import type { AgentDecision } from "./AgentDecision.js";
import type { AgentOperatingMode } from "./AgentOperatingMode.js";
import type { AgentCheckpoint } from "./AgentCheckpoint.js";
import {
  classifyVerificationCommand,
  type VerificationCommandClassification,
  type VerificationLevel,
} from "../command/CommandClassification.js";
import type { SubAgentBatchResult } from "./SubAgentTypes.js";
import { createDefaultAgentTaskContract } from "./AgentTaskContract.js";
import type { AgentTaskContract } from "./AgentTaskContract.js";
import {
  mergeFileReadCoverageList,
  parseReadFileResultData,
  type FileReadCoverage,
} from "./FileReadCoverage.js";

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
  runId: string;
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
  operatingMode: AgentOperatingMode;
  recoveredFromCheckpoint: boolean;
  recoveredRepositoryChanges: boolean;
  multiAgentEnabled: boolean;
  delegationResultCount: number;
  taskKind: AgentTaskContract["kind"];
  outputKind: AgentTaskContract["outputKind"];
  fileReadCoverage: FileReadCoverage[];
}

export interface AgentStateOptions {
  sessionId: string;
  runId?: string;
  repoPath: string;
  userGoal: string;
  maxSteps?: number;
  operatingMode?: AgentOperatingMode;
  recoveredCheckpoint?: AgentCheckpoint;
  multiAgentEnabled?: boolean;
  taskContract?: AgentTaskContract;
}

export interface AgentVerificationOutcome {
  command: string;
  success: boolean;
  exitCode: number | null;
  level: VerificationLevel;
  repositoryWide: boolean;
  scopePaths: string[];
}

export interface AgentCompletionEvidence {
  repositoryChanged: boolean;
  hasAnyVerification: boolean;
  hasVerificationAfterLatestChange: boolean;
  verificationAfterLatestChange: boolean;
  latestVerification?: AgentVerificationOutcome;
  verificationEvidence: AgentVerificationOutcome[];
  verificationEvidenceAfterLatestChange: AgentVerificationOutcome[];
}

type AgentExecutionAction =
  | { kind: "PATCH"; success: boolean }
  | { kind: "COMMAND"; classification: VerificationCommandClassification; result: AgentVerificationOutcome };

export class AgentState {
  readonly sessionId: string;
  readonly runId: string;
  readonly repoPath: string;
  readonly userGoal: string;
  maxSteps: number;
  step = 0;
  status: AgentStatus = "RUNNING";
  messages: AgentMessage[] = [];
  decisions: AgentDecision[] = [];
  toolResults: AgentToolExecutionResult[] = [];
  commandResults: CommandResult[] = [];
  patchResults: AgentPatchExecutionResult[] = [];
  lastError: string | null = null;
  finalDiff: string | null = null;
  readonly operatingMode: AgentOperatingMode;
  readonly recoveredCheckpoint: AgentCheckpoint | undefined;
  readonly multiAgentEnabled: boolean;
  taskContract: AgentTaskContract;
  delegationBatches: SubAgentBatchResult[] = [];
  private fileReadCoverage: FileReadCoverage[] = [];
  private readonly executionActions: AgentExecutionAction[] = [];

  constructor(options: AgentStateOptions) {
    this.sessionId = options.sessionId;
    this.runId = options.runId ?? `${options.sessionId}:run`;
    this.repoPath = options.repoPath;
    this.userGoal = options.userGoal;
    this.maxSteps = options.maxSteps ?? options.taskContract?.maxSteps ?? 20;
    this.operatingMode = options.operatingMode ?? "EXECUTE";
    this.recoveredCheckpoint = options.recoveredCheckpoint;
    this.multiAgentEnabled = options.multiAgentEnabled ?? false;
    this.taskContract = options.taskContract ?? createDefaultAgentTaskContract();
    this.delegationBatches = structuredClone(options.recoveredCheckpoint?.collaboration?.batches ?? []);
    this.fileReadCoverage = structuredClone(options.recoveredCheckpoint?.effects.fileReadCoverage ?? []);
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
    if (result.toolName === "read_file" && result.result.success) {
      const read = parseReadFileResultData(result.result.data);
      if (read) {
        this.fileReadCoverage = mergeFileReadCoverageList(this.fileReadCoverage, read);
      }
    }
  }

  getFileReadCoverage(): FileReadCoverage[] {
    return structuredClone(this.fileReadCoverage);
  }

  addCommandResult(result: CommandResult): void {
    this.commandResults.push(result);
    const classification = result.verification ?? classifyVerificationCommand(result.command);
    this.executionActions.push({
      kind: "COMMAND",
      classification,
      result: {
        command: result.command,
        success: result.success,
        exitCode: result.exitCode,
        level: classification.level,
        repositoryWide: classification.repositoryWide,
        scopePaths: classification.scopePaths,
      },
    });
  }

  addPatchResult(result: AgentPatchExecutionResult): void {
    this.patchResults.push(result);
    this.executionActions.push({ kind: "PATCH", success: result.result.success });
    if (result.result.success) {
      const changed = new Set(readStructuredChangedFiles(result.result.data)
        ?? extractChangedPathsFromUnifiedDiff(result.patch));
      this.fileReadCoverage = this.fileReadCoverage.filter((entry) => !changed.has(entry.path));
    }
  }

  addDelegationBatch(result: SubAgentBatchResult): void {
    this.delegationBatches.push(result);
  }

  getCompletionEvidence(): AgentCompletionEvidence {
    const recovered = this.recoveredCheckpoint?.effects;
    let repositoryChanged = recovered?.successfulPatch === true;
    let verificationAfterLatestChange = recovered?.verificationAfterPatch === true;
    let hasVerificationAfterLatestChange = recovered?.verificationAttemptedAfterPatch === true
      || verificationAfterLatestChange;
    const recoveredLatestVerification = recovered?.latestVerification ?? recovered?.latestTest;
    let latestVerification = recoveredLatestVerification
      ? normalizeVerificationOutcome(recoveredLatestVerification)
      : undefined;
    let hasAnyVerification = latestVerification !== undefined;
    let verificationEvidenceAfterLatestChange = (recovered?.verificationEvidenceAfterPatch ?? [])
      .map(normalizeVerificationOutcome);
    let verificationEvidence = latestVerification
      ? [normalizeVerificationOutcome(latestVerification), ...verificationEvidenceAfterLatestChange]
      : [...verificationEvidenceAfterLatestChange];

    for (const action of this.executionActions) {
      if (action.kind === "PATCH") {
        if (action.success) {
          repositoryChanged = true;
          hasVerificationAfterLatestChange = false;
          verificationAfterLatestChange = false;
          verificationEvidenceAfterLatestChange = [];
        }
        continue;
      }
      if (action.classification.level === "NONE") continue;
      hasAnyVerification = true;
      latestVerification = action.result;
      verificationEvidence.push(action.result);
      if (repositoryChanged) {
        hasVerificationAfterLatestChange = true;
        verificationEvidenceAfterLatestChange.push(action.result);
        verificationAfterLatestChange = verificationEvidenceAfterLatestChange.some((candidate) => candidate.success);
      }
    }

    return {
      repositoryChanged,
      hasAnyVerification,
      hasVerificationAfterLatestChange,
      verificationAfterLatestChange,
      verificationEvidence: uniqueVerificationEvidence(verificationEvidence),
      verificationEvidenceAfterLatestChange: uniqueVerificationEvidence(verificationEvidenceAfterLatestChange),
      ...(latestVerification ? { latestVerification } : {}),
    };
  }

  setLastError(error: string | null): void {
    this.lastError = error;
  }

  upgradeTaskContract(contract: AgentTaskContract): void {
    this.taskContract = contract;
    // The current Direct decision is counted immediately after the upgrade.
    // Preserve the upgraded contract's full budget for subsequent decisions.
    this.maxSteps = Math.max(this.maxSteps, this.step + 1 + contract.maxSteps);
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
      runId: this.runId,
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
      operatingMode: this.operatingMode,
      recoveredFromCheckpoint: this.recoveredCheckpoint !== undefined,
      recoveredRepositoryChanges: this.recoveredCheckpoint?.effects.successfulPatch === true,
      multiAgentEnabled: this.multiAgentEnabled,
      delegationResultCount: this.delegationBatches.length,
      taskKind: this.taskContract.kind,
      outputKind: this.taskContract.outputKind,
      fileReadCoverage: this.getFileReadCoverage(),
    };
  }
}

function readStructuredChangedFiles(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("changedFiles" in value)) {
    return undefined;
  }
  const changedFiles = (value as { changedFiles?: unknown }).changedFiles;
  if (!Array.isArray(changedFiles)) return undefined;
  return changedFiles.flatMap((file) => (
    typeof file === "object" && file !== null && !Array.isArray(file) && typeof file.path === "string"
      ? [file.path.replaceAll("\\", "/")]
      : []
  ));
}

function normalizeVerificationOutcome(outcome: {
  command: string;
  success: boolean;
  exitCode: number | null;
  level?: VerificationLevel;
  repositoryWide?: boolean;
  scopePaths?: string[];
}): AgentVerificationOutcome {
  const classification = classifyVerificationCommand(outcome.command);
  return {
    command: outcome.command,
    success: outcome.success,
    exitCode: outcome.exitCode,
    level: outcome.level ?? classification.level,
    repositoryWide: outcome.repositoryWide ?? classification.repositoryWide,
    scopePaths: outcome.scopePaths ?? classification.scopePaths,
  };
}

function uniqueVerificationEvidence(values: AgentVerificationOutcome[]): AgentVerificationOutcome[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.command}:${String(value.success)}:${String(value.exitCode)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-20);
}
