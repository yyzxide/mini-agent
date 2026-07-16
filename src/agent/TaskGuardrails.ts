import type { AgentDecision } from "./AgentDecision.js";
import type { AgentState } from "./AgentState.js";
import { looksLikeIndexedKnowledgeRequest } from "./TaskRouter.js";
import {
  buildTaskCompletionContract,
  hasEnoughContextForFileWrite,
  requiresRepositoryFileChange,
} from "./TaskCompletionContract.js";
import { isVerificationRelevant, verificationLevelAtLeast } from "../command/CommandClassification.js";

export { requiresRepositoryFileChange } from "./TaskCompletionContract.js";

export interface AgentDecisionGuardrailViolation {
  code: string;
  message: string;
}

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

function validateFinalDecision(
  state: AgentState,
  decision: Extract<AgentDecision, { type: "FINAL" }>,
): AgentDecisionGuardrailViolation | undefined {
  if (!decision.success) {
    return undefined;
  }
  const contract = buildTaskCompletionContract(state);
  const completionEvidence = state.getCompletionEvidence();
  const currentVerificationEvidence = completionEvidence.repositoryChanged
    ? completionEvidence.verificationEvidenceAfterLatestChange
    : completionEvidence.verificationEvidence;
  const sufficientVerification = currentVerificationEvidence.filter((evidence) => (
    verificationLevelAtLeast(evidence.level, contract.requiredVerificationLevel)
    && isVerificationRelevant(evidence, contract.targetFiles)
  ));
  const latestSufficientVerification = sufficientVerification.at(-1);
  const verificationSatisfied = latestSufficientVerification?.success === true;

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

  if (contract.requiresRepositoryChange && !completionEvidence.repositoryChanged) {
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

  if (contract.requiresVerification && !verificationSatisfied) {
    if (latestSufficientVerification?.success === false) {
      return {
        code: "FINAL_IGNORES_VERIFICATION_FAILURE",
        message: [
          "Postcondition failed: the verification performed after the latest repository change failed.",
          "Fix the failure and run a successful replacement verification before returning success.",
        ].join(" "),
      };
    }
    if (completionEvidence.repositoryChanged
      && completionEvidence.verificationEvidenceAfterLatestChange.length === 0
      && completionEvidence.hasAnyVerification) {
      return {
        code: "FINAL_WITH_STALE_VERIFICATION",
        message: [
          "Postcondition failed: the recorded verification predates the latest successful patch.",
          "Run a relevant test, typecheck, lint, or build command again before returning success.",
        ].join(" "),
      };
    }
    if (currentVerificationEvidence.length > 0) {
      return {
        code: "FINAL_WITH_INSUFFICIENT_VERIFICATION",
        message: [
          `Postcondition failed: this task requires ${contract.requiredVerificationLevel} verification after the latest change.`,
          "The recorded checks are weaker than required or target unrelated files.",
          "Run a relevant test, typecheck, lint, build, or syntax check at the required level before returning success.",
        ].join(" "),
      };
    }
    return {
      code: "FINAL_WITHOUT_REQUIRED_VERIFICATION",
      message: [
        "Postcondition failed: this task has no successful required verification evidence.",
        completionEvidence.repositoryChanged
          ? "Run a relevant test, typecheck, lint, or build command after the patch before returning success."
          : "Run the requested test, typecheck, lint, or build command before returning success.",
      ].join(" "),
    };
  }

  if (hasUnresolvedVerificationFailure(state)) {
    return {
      code: "FINAL_IGNORES_VERIFICATION_FAILURE",
      message: [
        "Postcondition failed: the latest verification command failed and no later verification command passed.",
        "Do not claim testing or verification succeeded.",
        "Run a successful replacement verification, or finish with FINAL success=false / FAILED.",
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
  return state.recoveredCheckpoint?.effects.knowledgeSearch;
}

function reportsInsufficientKnowledgeEvidence(summary: string): boolean {
  return /(?:未能?找到|没有找到|无(?:相关|可用|足够).{0,8}(?:证据|文档|内容|结果)|证据不足|知识库(?:中|里)?(?:没有|未找到|无)|无法(?:从|根据).{0,12}(?:知识库|索引文档).{0,12}(?:回答|确认)|无法回答)/i.test(summary)
    || /\b(?:(?:no|not enough|insufficient)\s+(?:relevant\s+)?(?:evidence|documents?|results?|context)|(?:could not|couldn't|cannot|can't)\s+(?:find|answer|verify)|not found)\b/i.test(summary);
}

function hasUnresolvedVerificationFailure(state: AgentState): boolean {
  const evidence = state.getCompletionEvidence();
  if (evidence.latestVerification?.success !== false) return false;
  return !evidence.repositoryChanged || evidence.hasVerificationAfterLatestChange;
}
