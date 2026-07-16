import { looksLikeDocumentCreationTask } from "./ArtifactIntent.js";
import type { AgentState, AgentCompletionEvidence } from "./AgentState.js";
import { looksLikeSaveToFileFollowUp } from "./TaskFollowUp.js";
import { looksLikeIndexedKnowledgeRequest } from "./TaskRouter.js";
import type { VerificationLevel } from "../command/CommandClassification.js";

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

const FILE_MUTATION_KEYWORDS = [
  "写入", "写进", "写到", "写个", "写一个", "做个", "做一个", "保存", "落盘", "创建", "新建",
  "新增", "添加", "加入", "追加", "修改", "改成", "更新", "修复", "重构", "删除", "移除", "重命名",
  "实现", "生成", "scaffold", "create", "write", "save", "implement", "modify", "update", "add", "append",
  "change", "fix", "refactor", "delete", "remove", "rename",
];

const FILE_TARGET_KEYWORDS = [
  "代码", "程序", "算法", "函数", "类", "文件", "页面", "游戏", "组件", "脚本", "html", "typescript",
  "javascript", "python", "java", "c++", "cpp", "go", "rust", "leetcode", "文档", "说明书", "报告",
  "指南", "手册", "readme", "documentation", "document", "specification", "manual",
];

const SOURCE_EXTENSION_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cpp|cc|c|h|hpp|cs|kt|kts|swift|rb|php|sh|bash|vue|svelte)$/i;
const CONFIG_EXTENSION_PATTERN = /\.(?:json|ya?ml|toml|xml)$/i;
const DOCUMENT_EXTENSION_PATTERN = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i;
const SOURCE_TASK_PATTERN = /(?:代码|程序|算法|函数|类|组件|脚本|typescript|javascript|python|java|c\+\+|cpp|golang|rust|\bcode\b|\bfunction\b|\bclass\b|\bcomponent\b|\bscript\b)/i;
const EXPLICIT_VERIFICATION_PATTERN = /(?:运行|执行|验证|检查|确保).{0,24}(?:测试|test|typecheck|类型检查|lint|构建|build|编译)|(?:run|execute|verify|validate|ensure).{0,24}(?:tests?|typecheck|lint|build|compile)/i;
const TEST_REQUIRED_PATTERN = /(?:修复|回归|重构|缺陷)|\b(?:bug|regression|refactor|fix)\b/i;
const EXPLICIT_TEST_PATTERN = /(?:运行|执行|验证|检查|确保).{0,24}(?:测试|test)|(?:run|execute|verify|validate|ensure).{0,24}tests?/i;
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

  const requiresKnowledgeEvidence = looksLikeIndexedKnowledgeRequest(state.userGoal);
  const requiresRepositoryChange = requiresRepositoryFileChange(state.userGoal)
    || state.getCompletionEvidence().repositoryChanged;
  const targetFiles = extractTargetFiles(state);
  const hasSourceTarget = targetFiles.some((file) => SOURCE_EXTENSION_PATTERN.test(file));
  const hasConfigTarget = targetFiles.some(isConfigurationFile);
  const hasDocumentTarget = targetFiles.length > 0 && targetFiles.every((file) => DOCUMENT_EXTENSION_PATTERN.test(file));
  const explicitVerification = EXPLICIT_VERIFICATION_PATTERN.test(state.userGoal);
  const inferredSourceTask = requiresRepositoryChange && targetFiles.length === 0 && SOURCE_TASK_PATTERN.test(state.userGoal);
  const requiredVerificationLevel = determineRequiredVerificationLevel({
    userGoal: state.userGoal,
    targetFiles,
    explicitVerification,
    hasSourceTarget,
    hasConfigTarget,
    inferredSourceTask,
  });
  const requiresVerification = requiredVerificationLevel !== "NONE";

  let kind: TaskCompletionKind = "ANSWER";
  if (requiresKnowledgeEvidence) kind = "KNOWLEDGE_QUERY";
  else if (explicitVerification && !requiresRepositoryChange) kind = "VERIFICATION";
  else if (hasSourceTarget || inferredSourceTask) kind = "SOURCE_CHANGE";
  else if (hasConfigTarget) kind = "CONFIGURATION_CHANGE";
  else if (requiresRepositoryChange && (hasDocumentTarget || looksLikeDocumentCreationTask(state.userGoal))) kind = "DOCUMENTATION_CHANGE";
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
  userGoal: string;
  targetFiles: string[];
  explicitVerification: boolean;
  hasSourceTarget: boolean;
  hasConfigTarget: boolean;
  inferredSourceTask: boolean;
}): VerificationLevel {
  if (input.targetFiles.length > 0 && input.targetFiles.every((file) => DOCUMENT_EXTENSION_PATTERN.test(file))) {
    return "NONE";
  }
  const testTarget = input.targetFiles.some((file) => /(?:^|[._-])(?:test|spec)\.[^.]+$/i.test(file));
  const codeLikeTarget = input.hasSourceTarget || input.hasConfigTarget || input.inferredSourceTask || testTarget;
  if (EXPLICIT_TEST_PATTERN.test(input.userGoal) || testTarget
    || (codeLikeTarget && TEST_REQUIRED_PATTERN.test(input.userGoal))) {
    return "TEST";
  }
  if (input.hasConfigTarget || input.inferredSourceTask
    || input.targetFiles.some((file) => STATIC_SOURCE_EXTENSION_PATTERN.test(file))) {
    return "STATIC";
  }
  if (input.targetFiles.some((file) => DYNAMIC_SOURCE_EXTENSION_PATTERN.test(file))) {
    return "SYNTAX";
  }
  if (input.hasSourceTarget) return "STATIC";
  return input.explicitVerification ? "STATIC" : "NONE";
}

export function requiresRepositoryFileChange(userGoal: string): boolean {
  const normalized = userGoal.trim().toLowerCase();
  if (!normalized) return false;
  if (looksLikeSaveToFileFollowUp(userGoal) || looksLikeDocumentCreationTask(userGoal)) return true;
  if (normalized.includes("真正写入仓库文件") || normalized.includes("需要落盘的代码如下")) return true;
  if (!FILE_MUTATION_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))) return false;
  return FILE_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))
    || /\.(?:ts|tsx|js|jsx|mjs|cjs|java|go|py|cpp|cc|c|h|hpp|html|css|rs|sh|vue|svelte|md|mdx|txt|json|ya?ml|toml|xml)\b/i.test(userGoal);
}

export function hasEnoughContextForFileWrite(userGoal: string): boolean {
  const normalized = userGoal.trim().toLowerCase();
  return normalized.includes("需要落盘的代码如下")
    || userGoal.includes("```")
    || looksLikeDocumentCreationTask(userGoal)
    || FILE_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function extractTargetFiles(state: AgentState): string[] {
  const currentModifiedFiles = state.patchResults
    .filter((result) => result.result.success)
    .flatMap((result) => [...result.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
      .map((match) => match[1])
      .filter((file): file is string => Boolean(file) && file !== "/dev/null"));
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
