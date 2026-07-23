import type { AgentDecision } from "./AgentDecision.js";
import type { AgentState } from "./AgentState.js";
import { looksLikeIndexedKnowledgeRequest } from "./TaskRouter.js";
import {
  buildTaskCompletionContract,
  hasEnoughContextForFileWrite,
  requiresRepositoryFileChange,
} from "./TaskCompletionContract.js";
import { isVerificationRelevant, verificationLevelAtLeast } from "../command/CommandClassification.js";
import { extractLikelyReviewFilePath } from "./RepositoryInvestigation.js";
import { normalizeReadPath } from "./FileReadCoverage.js";
import {
  findHigherNamedVersionCandidate,
  looksLikeAuthoritativeFreshnessQuery,
  looksLikeTemporalSuperlativeRequest,
  validateWebSearchQueryScope,
} from "./WebResearchPolicy.js";

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

  if (decision.type === "TOOL_CALL") {
    return validateToolCallDecision(state, decision);
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

  const taskContractViolation = validateTaskContractEvidence(state, decision.summary);
  if (taskContractViolation) {
    return taskContractViolation;
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

function validateTaskContractEvidence(
  state: AgentState,
  summary: string,
): AgentDecisionGuardrailViolation | undefined {
  const requirements = state.taskContract.evidence;

  if (requirements.repositoryRead && !hasSuccessfulToolCall(state, "read_file")) {
    return {
      code: "FINAL_WITHOUT_REPOSITORY_EVIDENCE",
      message: "Postcondition failed: this repository investigation must read relevant files before returning a final answer.",
    };
  }

  if (requirements.completeFileRead) {
    const coverage = state.getFileReadCoverage();
    const explicitTarget = extractLikelyReviewFilePath(state.userGoal);
    const contractTargets = buildTaskCompletionContract(state).targetFiles.map(normalizeReadPath);
    const targets = contractTargets.length > 0
      ? contractTargets
      : explicitTarget
        ? [normalizeReadPath(explicitTarget)]
        : coverage[0]?.path ? [coverage[0].path] : [];
    const target = targets.find((candidate) => {
      const item = coverage.find((entry) => normalizeReadPath(entry.path) === candidate);
      return !item?.complete;
    }) ?? targets[0];
    const targetCoverage = target ? coverage.find((entry) => normalizeReadPath(entry.path) === target) : undefined;
    if (!targetCoverage) {
      return {
        code: "FINAL_WITHOUT_COMPLETE_FILE_READ",
        message: [
          "Postcondition failed: this task requires complete coverage of the target file,",
          target ? `but no successful read_file result was recorded for ${target}.` : "but no target file coverage was recorded.",
          "Read the target with read_file before returning a final answer.",
        ].join(" "),
      };
    }
    if (!targetCoverage.complete) {
      return {
        code: "FINAL_WITH_INCOMPLETE_FILE_READ",
        message: [
          `Postcondition failed: ${targetCoverage.path} is only partially read.`,
          `Covered ${formatCoverageRanges(targetCoverage.ranges)} of ${String(targetCoverage.totalLines)} lines.`,
          `Continue with read_file path=${targetCoverage.path} startLine=${String(targetCoverage.nextStartLine ?? 1)}${targetCoverage.partialLine ? ` startColumn=${String(targetCoverage.partialLine.nextColumn)}` : ""} and repeat until hasMore=false.`,
        ].join(" "),
      };
    }
  }

  if (requirements.webSearch && !hasSuccessfulToolCall(state, "web_search")) {
    if (hasAttemptedToolCall(state, "web_search") && reportsInsufficientWebEvidence(summary)) {
      return undefined;
    }
    return {
      code: "FINAL_WITHOUT_WEB_SEARCH",
      message: "Postcondition failed: this web research task must perform a successful web_search before answering.",
    };
  }

  if (requirements.knowledgeSearch && !hasSuccessfulToolCall(state, "knowledge_search")) {
    return {
      code: "FINAL_WITHOUT_KNOWLEDGE_SEARCH",
      message: "Postcondition failed: this knowledge task must perform a successful knowledge_search before answering.",
    };
  }

  if (looksLikeTemporalSuperlativeRequest(state.userGoal) && !reportsInsufficientWebEvidence(summary)) {
    const searchQueries = successfulSearchQueries(state);
    if (searchQueries.length < 2) {
      return {
        code: "FINAL_WITHOUT_FRESHNESS_COMPARISON",
        message: [
          "Postcondition failed: a latest/current model, version, release, or product claim requires more than one non-equivalent search view.",
          "Run a second freshness search with different retrieval wording or scope; one search-engine result page cannot establish that no newer release exists.",
        ].join(" "),
      };
    }
    if (!searchQueries.some(looksLikeAuthoritativeFreshnessQuery)) {
      return {
        code: "FINAL_WITHOUT_AUTHORITATIVE_FRESHNESS_SEARCH",
        message: [
          "Postcondition failed: a latest/current model, version, release, or product claim cannot rely only on a generic search-engine ranking.",
          "Run an authority-targeted freshness search using official/官方, release notes, changelog, or a site: constraint, then inspect the newest relevant candidate.",
        ].join(" "),
      };
    }

    const higherVersion = findHigherNamedVersionCandidate(summary, successfulWebEvidenceTexts(state));
    if (higherVersion) {
      return {
        code: "FINAL_IGNORES_HIGHER_VERSION_CANDIDATE",
        message: [
          `Postcondition failed: the final answer claims ${higherVersion.claimed},`,
          `but gathered evidence also contains the higher same-family candidate ${higherVersion.candidate}.`,
          "Investigate and fetch the higher candidate before asserting which version is latest, or explicitly report unresolved conflicting evidence.",
        ].join(" "),
      };
    }
  }

  if (requirements.fetchedWebSourceCount > 0) {
    const fetchedUrls = successfulFetchedUrls(state);
    const domains = new Set(fetchedUrls.map(readDomain).filter((value): value is string => value !== undefined));
    const enoughFetches = fetchedUrls.length >= requirements.fetchedWebSourceCount;
    const enoughDomains = domains.size >= requirements.independentWebDomainCount;
    if ((!enoughFetches || !enoughDomains) && !reportsInsufficientWebEvidence(summary)) {
      return {
        code: "FINAL_WITH_INSUFFICIENT_WEB_EVIDENCE",
        message: [
          "Postcondition failed: the gathered web evidence does not meet this task's source threshold.",
          `Need ${String(requirements.fetchedWebSourceCount)} fetched source(s) across ${String(requirements.independentWebDomainCount)} domain(s).`,
          "Fetch additional independent sources or explicitly report that evidence is insufficient.",
        ].join(" "),
      };
    }
  }

  if (requirements.webCitation) {
    const gatheredUrls = successfulWebUrls(state);
    if (gatheredUrls.length > 0
      && !gatheredUrls.some((url) => summary.includes(url))
      && !reportsInsufficientWebEvidence(summary)) {
      return {
        code: "FINAL_WITHOUT_WEB_CITATION",
        message: "Postcondition failed: cite at least one exact URL gathered by web_search or fetch_url, or explicitly report insufficient evidence.",
      };
    }
  }

  return undefined;
}

function formatCoverageRanges(ranges: Array<{ startLine: number; endLine: number }>): string {
  return ranges.length > 0
    ? ranges.map((range) => `${String(range.startLine)}-${String(range.endLine)}`).join(",")
    : "(none)";
}

function hasSuccessfulToolCall(state: AgentState, toolName: string): boolean {
  return state.toolResults.some((result) => result.toolName === toolName && result.result.success);
}

function hasAttemptedToolCall(state: AgentState, toolName: string): boolean {
  return state.toolResults.some((result) => result.toolName === toolName);
}

function successfulFetchedUrls(state: AgentState): string[] {
  return state.toolResults
    .filter((result) => result.toolName === "fetch_url" && result.result.success)
    .map((result) => readObjectString(result.result.data, "finalUrl"))
    .filter((value): value is string => value !== undefined);
}

function successfulWebUrls(state: AgentState): string[] {
  const urls = [...successfulFetchedUrls(state), ...successfulSearchUrls(state)];
  return [...new Set(urls)];
}

function successfulSearchUrls(state: AgentState): string[] {
  const urls: string[] = [];
  for (const result of state.toolResults) {
    if (result.toolName !== "web_search" || !result.result.success || !isObject(result.result.data)) continue;
    const entries = result.result.data.results;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const url = readObjectString(entry, "url");
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

function successfulSearchQueries(state: AgentState): string[] {
  return [...new Set(state.toolResults
    .filter((result) => result.toolName === "web_search" && result.result.success)
    .map((result) => readObjectString(result.input, "query"))
    .filter((value): value is string => value !== undefined))];
}

function successfulWebEvidenceTexts(state: AgentState): string[] {
  const evidence: string[] = [];
  for (const result of state.toolResults) {
    if (!result.result.success || !isObject(result.result.data)) continue;
    if (result.toolName === "web_search") {
      const entries = result.result.data.results;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isObject(entry)) continue;
        const title = readObjectString(entry, "title");
        const snippet = readObjectString(entry, "snippet");
        if (title || snippet) evidence.push([title, snippet].filter(Boolean).join(" "));
      }
      continue;
    }
    if (result.toolName === "fetch_url") {
      const text = readObjectString(result.result.data, "text");
      if (text) evidence.push(text);
    }
  }
  return evidence;
}

function validateToolCallDecision(
  state: AgentState,
  decision: Extract<AgentDecision, { type: "TOOL_CALL" }>,
): AgentDecisionGuardrailViolation | undefined {
  if (decision.toolName === "web_search") {
    const previousTransportFailure = [...state.toolResults].reverse().find((result) =>
      result.toolName === "web_search"
      && !result.result.success
      && (result.result.error?.code === "WEB_SEARCH_FAILED"
        || result.result.error?.code === "WEB_SEARCH_TIMEOUT"),
    );
    if (previousTransportFailure) {
      return {
        code: "WEB_SEARCH_TRANSPORT_UNAVAILABLE",
        message: [
          "A prior web_search already failed at the transport/provider layer.",
          "The tool itself exhausted its configured provider fallback, so changing only the query cannot repair connectivity.",
          "Do not retry an equivalent search; finish by explicitly reporting insufficient web evidence.",
        ].join(" "),
      };
    }
    const query = readObjectString(decision.input, "query");
    return query ? validateWebSearchQueryScope(state.userGoal, query) : undefined;
  }
  if (decision.toolName !== "fetch_url") return undefined;

  const rawUrl = readObjectString(decision.input, "url");
  const requestedUrl = rawUrl ? normalizeHttpUrl(rawUrl) : undefined;
  if (!requestedUrl) return undefined;
  const allowedUrls = new Set([
    ...successfulSearchUrls(state).map(normalizeHttpUrl).filter((value): value is string => value !== undefined),
    ...extractHttpUrls(state.userGoal).map(normalizeHttpUrl).filter((value): value is string => value !== undefined),
  ]);
  if (allowedUrls.has(requestedUrl)) return undefined;

  return {
    code: successfulSearchUrls(state).length > 0
      ? "FETCH_URL_NOT_FROM_SEARCH_RESULTS"
      : "FETCH_URL_WITHOUT_GROUNDED_URL",
    message: successfulSearchUrls(state).length > 0
      ? "fetch_url was blocked because its URL was not returned by a successful web_search and was not supplied by the user. Fetch an exact gathered URL instead of inventing or repairing one."
      : "fetch_url was blocked because no successful web_search supplied this URL and the user did not provide it. Do not guess a likely source URL after search failure; report insufficient web evidence.",
  };
}

function readObjectString(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function extractHttpUrls(value: string): string[] {
  return value.match(/https?:\/\/[^\s<>"'）)]+/gi) ?? [];
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDomain(value: string): string | undefined {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length <= 2) return hostname;
    const publicSuffix = labels.slice(-2).join(".");
    const commonSecondLevelSuffixes = new Set([
      "co.uk", "org.uk", "ac.uk", "com.cn", "net.cn", "org.cn",
      "com.au", "net.au", "org.au", "co.jp", "co.kr", "com.br",
    ]);
    return labels.slice(commonSecondLevelSuffixes.has(publicSuffix) ? -3 : -2).join(".");
  } catch {
    return undefined;
  }
}

function reportsInsufficientWebEvidence(summary: string): boolean {
  return /(?:证据|来源|资料).{0,8}(?:不足|不充分|无法核验|无法确认)|(?:不足以|无法).{0,12}(?:核验|确认|回答)/i.test(summary)
    || /\b(?:insufficient|not enough|unable to verify|cannot verify|could not verify)\b/i.test(summary);
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
