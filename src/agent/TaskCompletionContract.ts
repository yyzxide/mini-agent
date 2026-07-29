import type { AgentState, AgentCompletionEvidence } from "./AgentState.js";
import type { VerificationLevel } from "../command/CommandClassification.js";
import { extractChangedPathsFromUnifiedDiff } from "../diff/ChangedPaths.js";

export type TaskCompletionKind =
  | "PLAN"
  | "KNOWLEDGE_QUERY"
  | "VERIFICATION"
  | "SOURCE_CHANGE"
  | "CONFIGURATION_CHANGE"
  | "DOCUMENTATION_CHANGE"
  | "REPOSITORY_CHANGE"
  | "ANSWER";

export interface TaskCompletionContract {
  kind: TaskCompletionKind;
  requiresRepositoryChange: boolean;
  requiresKnowledgeEvidence: boolean;
  requiresVerification: boolean;
  requiredVerificationLevel: VerificationLevel;
  targetFiles: string[];
  verificationReason?: string;
}

const SOURCE_EXTENSION_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cpp|cc|c|h|hpp|cs|kt|kts|swift|rb|php|sh|bash|vue|svelte)$/i;
const CONFIG_EXTENSION_PATTERN = /\.(?:json|ya?ml|toml|xml)$/i;
const DOCUMENT_EXTENSION_PATTERN = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i;
const STATIC_SOURCE_EXTENSION_PATTERN = /\.(?:ts|tsx|java|go|rs|cpp|cc|c|h|hpp|cs|kt|kts|swift|vue|svelte)$/i;
const DYNAMIC_SOURCE_EXTENSION_PATTERN = /\.(?:js|jsx|mjs|cjs|py|rb|php|sh|bash)$/i;
const FILE_PATH_PATTERN = /(?:^|[\s`'"(（])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cpp|cc|c|h|hpp|cs|kt|kts|swift|rb|php|sh|bash|vue|svelte|html|css|md|markdown|mdx|txt|rst|adoc|json|ya?ml|toml|xml))(?:$|[\s`'",.!?，。！？)）:：])/gi;

export function buildTaskCompletionContract(state: AgentState): TaskCompletionContract {
  if (state.operatingMode === "PLAN") {
    return {
      kind: "PLAN",
      requiresRepositoryChange: false,
      requiresKnowledgeEvidence: false,
      requiresVerification: false,
      requiredVerificationLevel: "NONE",
      targetFiles: extractTargetFiles(state),
    };
  }

  const completionEvidence = state.getCompletionEvidence();
  const taskFrame = state.taskContract.taskFrame;
  const requiresKnowledgeEvidence = taskFrame?.effects.knowledgeEvidence === true
    || state.taskContract.evidence.knowledgeSearch;
  // Completion requirements consume the one resolved semantic record. They
  // must not independently reinterpret raw user wording. Conditional mutation
  // tasks require verification only after a patch actually occurs.
  const requiresRepositoryChange = completionEvidence.repositoryChanged
    || taskFrame?.effects.repositoryWrite === "REQUIRED";
  const targetFiles = extractTargetFiles(state);
  const hasSourceTarget = targetFiles.some((file) => SOURCE_EXTENSION_PATTERN.test(file));
  const hasConfigTarget = targetFiles.some(isConfigurationFile);
  const hasDocumentTarget = targetFiles.length > 0 && targetFiles.every((file) => DOCUMENT_EXTENSION_PATTERN.test(file));
  const explicitVerification = taskFrame !== undefined
    && taskFrame.effects.verification !== "NONE";
  const requiredVerificationLevel = requiresRepositoryChange || explicitVerification
    ? taskFrame && taskFrame.effects.verification !== "NONE"
      ? taskFrame.effects.verification
      : determineRequiredVerificationLevel({
        targetFiles,
        hasSourceTarget,
        hasConfigTarget,
      })
    : "NONE";
  const requiresVerification = requiredVerificationLevel !== "NONE";

  let kind: TaskCompletionKind = "ANSWER";
  if (requiresKnowledgeEvidence) kind = "KNOWLEDGE_QUERY";
  else if (explicitVerification && !requiresRepositoryChange) kind = "VERIFICATION";
  else if (hasSourceTarget) kind = "SOURCE_CHANGE";
  else if (hasConfigTarget) kind = "CONFIGURATION_CHANGE";
  else if (requiresRepositoryChange && hasDocumentTarget) kind = "DOCUMENTATION_CHANGE";
  else if (requiresRepositoryChange) kind = "REPOSITORY_CHANGE";

  return {
    kind,
    requiresRepositoryChange,
    requiresKnowledgeEvidence,
    requiresVerification,
    requiredVerificationLevel,
    targetFiles,
    ...(requiresVerification
      ? {
        verificationReason: explicitVerification
        ? `The user explicitly requested verification at ${requiredVerificationLevel} level.`
          : hasConfigTarget
            ? "Configuration changes require a successful check after the latest patch."
            : "Source changes require a successful check after the latest patch.",
      }
      : {}),
  };
}

export function formatTaskCompletionContract(
  contract: TaskCompletionContract,
  evidence: AgentCompletionEvidence,
): string {
  const acceptance = [
    ...(contract.requiresRepositoryChange ? ["A repository patch must be applied successfully."] : []),
    ...(contract.requiresKnowledgeEvidence ? ["Indexed knowledge evidence and citations must ground the answer."] : []),
    ...(contract.requiresVerification
      ? [evidence.repositoryChanged
        ? `A relevant ${contract.requiredVerificationLevel} verification command must pass after the most recent successful patch.`
        : `A relevant ${contract.requiredVerificationLevel} verification command must pass.`]
      : []),
  ];
  return [
    `Kind: ${contract.kind}`,
    `Target files: ${contract.targetFiles.length > 0 ? contract.targetFiles.join(" | ") : "(inferred from task)"}`,
    `Repository change required: ${yesNo(contract.requiresRepositoryChange)}`,
    `Knowledge evidence required: ${yesNo(contract.requiresKnowledgeEvidence)}`,
    `Verification after latest change required: ${yesNo(contract.requiresVerification)}`,
    `Minimum verification level: ${contract.requiredVerificationLevel}`,
    ...(contract.verificationReason ? [`Reason: ${contract.verificationReason}`] : []),
    `Current repository change evidence: ${yesNo(evidence.repositoryChanged)}`,
    `Current verification after latest change: ${yesNo(evidence.verificationAfterLatestChange)}`,
    `Post-change verification evidence: ${evidence.verificationEvidenceAfterLatestChange.length > 0
      ? evidence.verificationEvidenceAfterLatestChange.map((item) => `${item.level}:${item.success ? "PASS" : "FAIL"}:${item.command}`).join(" | ")
      : "(none)"}`,
    `Latest verification: ${evidence.latestVerification
      ? `${evidence.latestVerification.success ? "PASS" : "FAIL"}: ${evidence.latestVerification.command}`
      : "(none)"}`,
    `Acceptance criteria: ${acceptance.length > 0 ? acceptance.join(" ") : "Answer the current request accurately."}`,
  ].join("\n");
}

function determineRequiredVerificationLevel(input: {
  targetFiles: string[];
  hasSourceTarget: boolean;
  hasConfigTarget: boolean;
}): VerificationLevel {
  if (input.targetFiles.length > 0 && input.targetFiles.every((file) => DOCUMENT_EXTENSION_PATTERN.test(file))) {
    return "NONE";
  }
  const testTarget = input.targetFiles.some((file) => /(?:^|[._-])(?:test|spec)\.[^.]+$/i.test(file));
  if (testTarget) {
    return "TEST";
  }
  if (input.hasConfigTarget
    || input.targetFiles.some((file) => STATIC_SOURCE_EXTENSION_PATTERN.test(file))) {
    return "STATIC";
  }
  if (input.targetFiles.some((file) => DYNAMIC_SOURCE_EXTENSION_PATTERN.test(file))) {
    return "SYNTAX";
  }
  if (input.hasSourceTarget) return "STATIC";
  return "NONE";
}

function extractTargetFiles(state: AgentState): string[] {
  const currentModifiedFiles = state.patchResults
    .filter((result) => result.result.success)
    .flatMap((result) => extractChangedPathsFromUnifiedDiff(result.patch));
  const modifiedFiles = unique([...(state.recoveredCheckpoint?.workingSet.modifiedFiles ?? []), ...currentModifiedFiles]);
  if (modifiedFiles.length > 0) return modifiedFiles;
  return unique([...state.userGoal.matchAll(FILE_PATH_PATTERN)]
    .map((match) => match[1])
    .filter((file): file is string => Boolean(file)));
}

function isConfigurationFile(file: string): boolean {
  const name = file.split("/").at(-1) ?? file;
  return CONFIG_EXTENSION_PATTERN.test(file)
    || /^(?:package|composer)\.json$/i.test(name)
    || /^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/i.test(name)
    || /^(?:vite|vitest|jest|eslint|prettier|webpack|rollup)\.config\./i.test(name);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(-20);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
