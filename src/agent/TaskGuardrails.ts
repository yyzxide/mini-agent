import type { AgentDecision } from "./AgentDecision.js";
import type { AgentState } from "./AgentState.js";
import { looksLikeDocumentCreationTask } from "./ArtifactIntent.js";
import { looksLikeSaveToFileFollowUp } from "./TaskFollowUp.js";
import { looksLikeIndexedKnowledgeRequest } from "./TaskRouter.js";
import { isTestCommand } from "../command/CommandClassification.js";

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

const FILE_TARGET_KEYWORDS = [
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
  "文档",
  "说明书",
  "报告",
  "指南",
  "手册",
  "readme",
  "documentation",
  "document",
  "specification",
  "manual",
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

  if (looksLikeDocumentCreationTask(userGoal)) {
    return true;
  }

  if (normalized.includes("真正写入仓库文件") || normalized.includes("需要落盘的代码如下")) {
    return true;
  }

  const mentionsMutation = FILE_MUTATION_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  if (!mentionsMutation) {
    return false;
  }

  return FILE_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))
    || /\.(ts|tsx|js|jsx|java|go|py|cpp|cc|c|html|css|rs|sh|md)\b/i.test(userGoal);
}

function validateFinalDecision(
  state: AgentState,
  decision: Extract<AgentDecision, { type: "FINAL" }>,
): AgentDecisionGuardrailViolation | undefined {
  if (!decision.success) {
    return undefined;
  }

  if (looksLikeIndexedKnowledgeRequest(state.userGoal) && !hasSuccessfulKnowledgeSearch(state)) {
    return {
      code: "FINAL_WITHOUT_KNOWLEDGE_SEARCH",
      message: [
        "Postcondition failed: this task explicitly asks about the indexed knowledge base,",
        "but no successful knowledge_search tool call was recorded.",
        "Query the document RAG before answering, and preserve its citations or report insufficient evidence.",
      ].join(" "),
    };
  }

  const knowledgeOutcome = readLatestKnowledgeSearchOutcome(state);
  if (
    looksLikeIndexedKnowledgeRequest(state.userGoal)
    && knowledgeOutcome?.found === false
    && !reportsInsufficientKnowledgeEvidence(decision.summary)
  ) {
    return {
      code: "FINAL_IGNORES_INSUFFICIENT_KNOWLEDGE",
      message: [
        "Postcondition failed: knowledge_search found no grounded document evidence,",
        "but the final answer did not explicitly report that limitation.",
        "Do not answer from memory or invention; state that the indexed knowledge base lacks sufficient evidence.",
      ].join(" "),
    };
  }

  if (
    looksLikeIndexedKnowledgeRequest(state.userGoal)
    && knowledgeOutcome?.found === true
    && (
      knowledgeOutcome.citations.length === 0
      || !knowledgeOutcome.citations.some((citation) => decision.summary.includes(citation))
    )
  ) {
    return {
      code: "FINAL_WITHOUT_KNOWLEDGE_CITATION",
      message: [
        "Postcondition failed: knowledge_search returned grounded document citations,",
        "but the final answer did not preserve any of them.",
        "Answer from the retrieved evidence and include at least one exact file-and-line citation.",
      ].join(" "),
    };
  }

  if (requiresRepositoryFileChange(state.userGoal) && !hasSuccessfulPatch(state)) {
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

  if (hasUnresolvedTestFailure(state)) {
    return {
      code: "FINAL_IGNORES_TEST_FAILURE",
      message: [
        "Postcondition failed: the latest test command failed and no later test command passed.",
        "Do not claim testing or verification succeeded.",
        "Run a successful replacement test, or finish with FINAL success=false / FAILED.",
      ].join(" "),
    };
  }

  return undefined;
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

function hasSuccessfulKnowledgeSearch(state: AgentState): boolean {
  return readLatestKnowledgeSearchOutcome(state) !== undefined;
}

interface KnowledgeSearchOutcome {
  found: boolean;
  citations: string[];
}

function readLatestKnowledgeSearchOutcome(state: AgentState): KnowledgeSearchOutcome | undefined {
  for (const toolResult of [...state.toolResults].reverse()) {
    if (toolResult.toolName !== "knowledge_search" || !toolResult.result.success) {
      continue;
    }
    const data = toolResult.result.data;
    if (typeof data !== "object" || data === null || Array.isArray(data) || !("found" in data)) {
      continue;
    }
    const found = (data as { found?: unknown }).found;
    if (typeof found !== "boolean") {
      continue;
    }
    const citations = "citations" in data ? (data as { citations?: unknown }).citations : undefined;
    return {
      found,
      citations: Array.isArray(citations)
        ? citations.filter((citation): citation is string => typeof citation === "string" && citation.length > 0)
        : [],
    };
  }
  return undefined;
}

function reportsInsufficientKnowledgeEvidence(summary: string): boolean {
  return /(?:未能?找到|没有找到|无(?:相关|可用|足够).{0,8}(?:证据|文档|内容|结果)|证据不足|知识库(?:中|里)?(?:没有|未找到|无)|无法(?:从|根据).{0,12}(?:知识库|索引文档).{0,12}(?:回答|确认)|无法回答)/i.test(summary)
    || /\b(?:(?:no|not enough|insufficient)\s+(?:relevant\s+)?(?:evidence|documents?|results?|context)|(?:could not|couldn't|cannot|can't)\s+(?:find|answer|verify)|not found)\b/i.test(summary);
}

function hasUnresolvedTestFailure(state: AgentState): boolean {
  const latestTestResult = state.commandResults.filter((result) => isTestCommand(result.command)).at(-1);
  return latestTestResult !== undefined && !latestTestResult.success;
}

function hasEnoughContextForFileWrite(userGoal: string): boolean {
  const normalized = normalize(userGoal);
  return normalized.includes("需要落盘的代码如下")
    || userGoal.includes("```")
    || looksLikeDocumentCreationTask(userGoal)
    || FILE_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
