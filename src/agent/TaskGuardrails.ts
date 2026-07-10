import type { AgentDecision } from "./AgentDecision.js";
import type { AgentState } from "./AgentState.js";
import { looksLikeSaveToFileFollowUp } from "./TaskFollowUp.js";

export interface AgentDecisionGuardrailViolation {
  code: string;
  message: string;
}

const FILE_MUTATION_KEYWORDS = [
  "写入",
  "写进",
  "写到",
  "写个",
  "写一个",
  "做个",
  "做一个",
  "保存",
  "落盘",
  "创建",
  "新建",
  "新增",
  "修改",
  "改成",
  "实现",
  "生成",
  "scaffold",
  "create",
  "write",
  "save",
  "implement",
  "modify",
  "update",
];

const CODE_TARGET_KEYWORDS = [
  "代码",
  "程序",
  "算法",
  "函数",
  "类",
  "文件",
  "页面",
  "游戏",
  "组件",
  "脚本",
  "html",
  "typescript",
  "javascript",
  "python",
  "java",
  "c++",
  "cpp",
  "go",
  "rust",
  "leetcode",
];

const REDUNDANT_FILE_WRITE_QUESTION_PATTERNS = [
  /(写入|保存|创建|新建).*(什么|哪个|哪里|路径|文件|内容)/i,
  /(请|麻烦)?.*(提供|告诉).*(文件|路径|内容|代码)/i,
  /(what|which).*(file|path|content|code)/i,
  /(provide|tell me).*(file|path|content|code)/i,
];

export function validateAgentDecisionGuardrails(
  state: AgentState,
  decision: AgentDecision,
): AgentDecisionGuardrailViolation | undefined {
  if (state.operatingMode === "PLAN") {
    return undefined;
  }
  if (decision.type === "FINAL") {
    return validateFinalDecision(state, decision);
  }

  if (decision.type === "ASK_USER") {
    return validateAskUserDecision(state, decision);
  }

  return undefined;
}

export function requiresRepositoryFileChange(userGoal: string): boolean {
  const normalized = normalize(userGoal);
  if (!normalized) {
    return false;
  }

  if (looksLikeSaveToFileFollowUp(userGoal)) {
    return true;
  }

  if (normalized.includes("真正写入仓库文件") || normalized.includes("需要落盘的代码如下")) {
    return true;
  }

  const mentionsMutation = FILE_MUTATION_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  if (!mentionsMutation) {
    return false;
  }

  return CODE_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))
    || /\.(ts|tsx|js|jsx|java|go|py|cpp|cc|c|html|css|rs|sh|md)\b/i.test(userGoal);
}

function validateFinalDecision(
  state: AgentState,
  decision: Extract<AgentDecision, { type: "FINAL" }>,
): AgentDecisionGuardrailViolation | undefined {
  if (!decision.success || !requiresRepositoryFileChange(state.userGoal)) {
    return undefined;
  }

  if (hasSuccessfulPatch(state)) {
    return undefined;
  }

  return {
    code: "FINAL_WITHOUT_REPOSITORY_CHANGE",
    message: [
      "Postcondition failed: this task asks for repository file changes,",
      "but no successful APPLY_PATCH step was recorded.",
      "Do not claim the file was written. Next decision should use APPLY_PATCH",
      "or FAILED with a clear reason if a patch cannot be produced.",
    ].join(" "),
  };
}

function validateAskUserDecision(
  state: AgentState,
  decision: Extract<AgentDecision, { type: "ASK_USER" }>,
): AgentDecisionGuardrailViolation | undefined {
  if (!requiresRepositoryFileChange(state.userGoal)) {
    return undefined;
  }

  if (!hasEnoughContextForFileWrite(state.userGoal)) {
    return undefined;
  }

  if (!REDUNDANT_FILE_WRITE_QUESTION_PATTERNS.some((pattern) => pattern.test(decision.message))) {
    return undefined;
  }

  return {
    code: "REDUNDANT_FILE_WRITE_QUESTION",
    message: [
      "Guardrail blocked a redundant clarification question.",
      "The current task already contains enough context to choose a sensible file path",
      "and write code through APPLY_PATCH. Do not ask the user to repeat the code or target file.",
    ].join(" "),
  };
}

function hasSuccessfulPatch(state: AgentState): boolean {
  return state.patchResults.some((patchResult) => patchResult.result.success);
}

function hasEnoughContextForFileWrite(userGoal: string): boolean {
  const normalized = normalize(userGoal);
  return normalized.includes("需要落盘的代码如下")
    || userGoal.includes("```")
    || CODE_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
