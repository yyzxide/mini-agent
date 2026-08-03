import type { AgentDecision } from "./AgentDecision.js";
import type { AgentState } from "./AgentState.js";
import { buildTaskCompletionContract } from "./TaskCompletionContract.js";
import { isVerificationRelevant, verificationLevelAtLeast } from "../command/CommandClassification.js";
import { extractLikelyReviewFilePath } from "./RepositoryInvestigation.js";
import { normalizeReadPath } from "./FileReadCoverage.js";
import {
  findHigherNamedVersionCandidate,
  looksLikeAuthoritativeFreshnessQuery,
  validateWebSearchQueryScope,
} from "./WebResearchPolicy.js";
import { assessAuthoritativeFreshnessEvidence } from "./WebResearchEvidence.js";
import { isWebSynthesisReserveActive } from "./WebResearchProgress.js";
import { validateAnswerQuality } from "./AnswerQualityPolicy.js";
import { resolveTaskCollaborationPolicy } from "./TaskCollaborationPolicy.js";

export interface AgentDecisionGuardrailViolation {
  code: string;
  message: string;
}

export function validateAgentDecisionGuardrails(
  state: AgentState,
  decision: AgentDecision,
): AgentDecisionGuardrailViolation | undefined {
  if (state.operatingMode === "PLAN") {
    return undefined;
  }
  if (
    isWebSynthesisReserveActive(state)
    && decision.type !== "FINAL"
    && decision.type !== "FAILED"
  ) {
    return {
      code: "WEB_FINAL_SYNTHESIS_RESERVED",
      message: [
        "The Web research final-synthesis reserve is active, so tool calls, plans, and questions are no longer allowed.",
        "Use the Web research progress section: return a cited FINAL success=true when evidence is ready; otherwise return FINAL success=false or FAILED with a transparent insufficient-evidence explanation.",
      ].join(" "),
    };
  }
  if (decision.type === "FINAL") {
    return validateFinalDecision(state, decision);
  }

  if (decision.type === "TOOL_CALL") {
    return validateToolCallDecision(state, decision);
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
  const evidenceInsufficient = decision.evidenceStatus === "INSUFFICIENT";
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
  const collaborationIntent = resolveTaskCollaborationPolicy(
    state.taskContract,
  );
  const delegatedResults = state.delegationBatches.flatMap((batch) => batch.results);

  if (
    collaborationIntent.preference === "REQUIRED"
    && state.delegationBatches.length === 0
  ) {
    return {
      code: "FINAL_WITHOUT_REQUESTED_DELEGATION",
      message: "Postcondition failed: the user explicitly requested subagent collaboration, but no DELEGATE batch was executed.",
    };
  }
  if (
    collaborationIntent.preference === "REQUIRED"
    && collaborationIntent.requestsChangeProposal
    && state.taskContract.capabilities.repositoryWrite
    && !delegatedResults.some((result) => result.status === "COMPLETED" && result.proposedPatch)
  ) {
    return {
      code: "FINAL_WITHOUT_DELEGATED_CHANGE_PROPOSAL",
      message: "Postcondition failed: the requested implementation subagent did not produce a validated patch proposal.",
    };
  }
  if (
    collaborationIntent.preference === "REQUIRED"
    && collaborationIntent.requestsReview
    && !delegatedResults.some((result) => result.status === "COMPLETED" && result.reviewedTaskIds?.length)
  ) {
    return {
      code: "FINAL_WITHOUT_DELEGATED_REVIEW",
      message: "Postcondition failed: the user requested a subagent review, but no dependent change_reviewer completed.",
    };
  }

  const taskContractViolation = validateTaskContractEvidence(
    state,
    decision,
    evidenceInsufficient,
  );
  if (taskContractViolation) {
    return taskContractViolation;
  }
  if (
    state.taskContract.taskFrame?.effects.answer !== false
    && !evidenceInsufficient
  ) {
    const answerQualityViolation = validateAnswerQuality(
      decision.summary,
      state.taskContract.taskFrame,
    );
    if (answerQualityViolation) return answerQualityViolation;
  }
  if (
    isKnowledgeTask(state)
    && !hasSuccessfulKnowledgeSearch(state)
    && !(hasAttemptedToolCall(state, "knowledge_search") && evidenceInsufficient)
  ) {
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
    isKnowledgeTask(state)
    && knowledgeOutcome?.found === false
    && !evidenceInsufficient
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
    isKnowledgeTask(state)
    && knowledgeOutcome?.found === true
    && (
      knowledgeOutcome.citations.length === 0
      || !knowledgeOutcome.citations.some((citation) => summaryIncludesKnowledgeCitation(decision.summary, citation))
    )
  ) {
    return {
      code: "FINAL_WITHOUT_KNOWLEDGE_CITATION",
      message: [
        "Postcondition failed: knowledge_search returned grounded document citations,",
        "but the final answer did not preserve any of them.",
        "Answer from the retrieved evidence and include at least one file-and-line citation for the returned source range.",
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
  decision: Extract<AgentDecision, { type: "FINAL" }>,
  evidenceInsufficient: boolean,
): AgentDecisionGuardrailViolation | undefined {
  const summary = decision.summary;
  const requirements = state.taskContract.evidence;

  if (requirements.repositoryRead && !hasSuccessfulRepositoryEvidence(state)) {
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
      const item = findReadCoverageForTarget(coverage, candidate);
      return !item?.complete;
    }) ?? targets[0];
    const targetCoverage = target ? findReadCoverageForTarget(coverage, target) : undefined;
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

  if (
    requirements.webSearch
    && !hasSuccessfulToolCall(state, "web_search")
    && !(hasAttemptedToolCall(state, "web_search") && evidenceInsufficient)
  ) {
    return {
      code: "FINAL_WITHOUT_WEB_SEARCH",
      message: "Postcondition failed: this web research task must perform a successful web_search before answering.",
    };
  }

  if (
    requirements.knowledgeSearch
    && !hasSuccessfulToolCall(state, "knowledge_search")
    && !(hasAttemptedToolCall(state, "knowledge_search") && evidenceInsufficient)
  ) {
    return {
      code: "FINAL_WITHOUT_KNOWLEDGE_SEARCH",
      message: "Postcondition failed: this knowledge task must perform a successful knowledge_search before answering.",
    };
  }

  if (requirements.webFreshnessRequired && !evidenceInsufficient) {
    const searchQueries = successfulSearchQueries(state);
    if (searchQueries.length < requirements.webSearchViewCount) {
      return {
        code: "FINAL_WITHOUT_FRESHNESS_COMPARISON",
        message: [
          "Postcondition failed: a latest/current model, version, release, or product claim requires more than one non-equivalent search view.",
          `Run ${String(requirements.webSearchViewCount)} freshness search views with different retrieval wording or scope; one search-engine result page cannot establish that no newer release exists.`,
        ].join(" "),
      };
    }

    const authorityEvidence = requirements.webAuthorityRequired
      ? assessAuthoritativeFreshnessEvidence(state)
      : undefined;
    if (authorityEvidence?.status === "NO_AUTHORITY_FRESHNESS_SEARCH") {
      return {
        code: "FINAL_WITHOUT_AUTHORITATIVE_FRESHNESS_SEARCH",
        message: [
          "Postcondition failed: no successful search produced candidates from an authority-targeted freshness query.",
          "The next decision must be TOOL_CALL web_search, not FINAL.",
          "Use a query that combines an authority target with current-time intent, for example: site:<official-domain> <entity> latest model release <current-year>.",
          "A current or adjacent year counts as retrieval intent, but search rank alone is never final evidence.",
        ].join(" "),
      };
    }
    if (authorityEvidence?.status === "AUTHORITY_RESULT_NOT_FETCHED") {
      return {
        code: "FINAL_WITHOUT_AUTHORITATIVE_SOURCE_INSPECTION",
        message: [
          "Postcondition failed: an authority-targeted freshness search succeeded, but none of its exact returned candidate URLs was successfully fetched.",
          "The next decision must be TOOL_CALL fetch_url using an exact candidate URL from that search, not FINAL.",
          "Inspect the canonical product, release-index, release-note, or changelog page before asserting what is latest.",
        ].join(" "),
      };
    }
    if (authorityEvidence?.status === "FETCHED_SOURCE_LACKS_TEMPORAL_EVIDENCE") {
      return {
        code: "FINAL_WITHOUT_VISIBLE_FRESHNESS_EVIDENCE",
        message: [
          "Postcondition failed: the fetched authority-search candidate does not expose a visible version, date, release, launch, update, or current/latest marker.",
          "The next decision must gather another exact official candidate, preferably release notes, a changelog, or a dated release index; do not repeat FINAL.",
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
    if ((!enoughFetches || !enoughDomains) && !evidenceInsufficient) {
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

  if (requirements.webCitation && !evidenceInsufficient) {
    const gatheredUrls = requirements.fetchedWebSourceCount > 0
      ? successfulFetchedUrls(state)
      : successfulWebUrls(state);
    if (gatheredUrls.length > 0
      && !gatheredUrls.some((url) => summary.includes(url))
    ) {
      return {
        code: "FINAL_WITHOUT_WEB_CITATION",
        message: "Postcondition failed: cite at least one exact URL whose page was successfully fetched and inspected, or explicitly report insufficient evidence.",
      };
    }
  }

  if (!evidenceInsufficient && state.taskContract.taskFrame?.webEvidencePolicy.profile !== "ORDINARY") {
    if (!decision.webClaims?.length) {
      return {
        code: "FINAL_WITHOUT_WEB_CLAIM_SOURCES",
        message: [
          "Postcondition failed: strict Web research requires a structured webClaims mapping.",
          "Map each material factual conclusion to exact successfully fetched sourceUrls and keep both the claim and URLs visible in summary.",
        ].join(" "),
      };
    }
  }

  if (decision.webClaims?.length) {
    const fetchedUrls = new Set(successfulFetchedUrls(state)
      .map(normalizeComparableUrl)
      .filter((value): value is string => value !== undefined));
    for (const mapping of decision.webClaims) {
      if (!normalizeComparableText(summary).includes(normalizeComparableText(mapping.claim))) {
        return {
          code: "FINAL_WEB_CLAIM_NOT_VISIBLE",
          message: `Postcondition failed: mapped Web claim is not present in the user-visible summary: ${mapping.claim}`,
        };
      }
      for (const sourceUrl of mapping.sourceUrls) {
        const normalizedUrl = normalizeComparableUrl(sourceUrl);
        if (!normalizedUrl || !fetchedUrls.has(normalizedUrl)) {
          return {
            code: "FINAL_WEB_CLAIM_SOURCE_NOT_FETCHED",
            message: `Postcondition failed: Web claim source was not successfully fetched and inspected: ${sourceUrl}`,
          };
        }
        if (!summary.includes(sourceUrl)) {
          return {
            code: "FINAL_WEB_CLAIM_SOURCE_NOT_VISIBLE",
            message: `Postcondition failed: mapped source URL is missing from the user-visible summary: ${sourceUrl}`,
          };
        }
      }
    }
  }

  return undefined;
}

function normalizeComparableText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeComparableUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hasSuccessfulRepositoryEvidence(state: AgentState): boolean {
  if (hasSuccessfulToolCall(state, "read_file")) return true;
  if (state.toolResults.some((result) => (
    result.toolName === "skill_read"
    && result.result.success
    && readObjectString(result.result.data, "source") === "repository"
  ))) return true;
  return state.delegationBatches.some((batch) => batch.results.some((result) => (
    result.status === "COMPLETED"
    && result.evidence.length > 0
    && result.toolsCalled.some((tool) => [
      "read_file",
      "list_files",
      "search_code",
      "git_status",
      "git_diff",
    ].includes(tool))
  )));
}

function findReadCoverageForTarget(
  coverage: ReturnType<AgentState["getFileReadCoverage"]>,
  target: string,
) {
  const normalizedTarget = normalizeReadPath(target);
  const exact = coverage.find((entry) => normalizeReadPath(entry.path) === normalizedTarget);
  if (exact) return exact;
  const suffixMatches = coverage.filter((entry) => normalizeReadPath(entry.path).endsWith(`/${normalizedTarget}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
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
  const queries = state.toolResults
    .filter((result) => result.toolName === "web_search" && result.result.success)
    .map((result) => readObjectString(result.input, "query"))
    .filter((value): value is string => value !== undefined);
  const seen = new Set<string>();
  return queries.filter((query) => {
    const normalized = query.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
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
    if (
      query
      && state.taskContract.evidence.webAuthorityRequired
      && successfulSearchQueries(state).length >= 1
      && assessAuthoritativeFreshnessEvidence(state).status === "NO_AUTHORITY_FRESHNESS_SEARCH"
      && !looksLikeAuthoritativeFreshnessQuery(query)
    ) {
      return {
        code: "TEMPORAL_AUTHORITY_SEARCH_REQUIRED",
        message: [
          "A generic search view already succeeded for this latest/current claim.",
          "The next web_search must be authority-targeted and freshness-aware before running more generic searches.",
          "Use official/官方, release notes, changelog, or site:<official-domain>, together with latest/current/release/model or the current year.",
        ].join(" "),
      };
    }
    const ranking = state.taskContract.taskFrame?.webEvidencePolicy.ranking;
    return query && ranking
      ? validateWebSearchQueryScope(ranking, query)
      : undefined;
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

function summaryIncludesKnowledgeCitation(summary: string, citation: string): boolean {
  if (summary.includes(citation)) return true;
  const parsed = citation.match(/^(.*?)#L(\d+)(?:-L(\d+))?$/iu);
  if (!parsed?.[1] || !parsed[2]) return false;
  const source = parsed[1];
  const expectedStart = Number(parsed[2]);
  const expectedEnd = Number(parsed[3] ?? parsed[2]);
  const locator = new RegExp([
    escapeRegExp(source),
    "\\s*(?:",
    "#L(\\d+)(?:-L(\\d+))?",
    "|:(\\d+)",
    "|第\\s*(\\d+)(?:\\s*[-–—至到]\\s*(\\d+))?\\s*行",
    ")",
  ].join(""), "giu");
  for (const match of summary.matchAll(locator)) {
    const citedStart = Number(match[1] ?? match[3] ?? match[4]);
    const citedEnd = Number(match[2] ?? match[5] ?? citedStart);
    if (Number.isFinite(citedStart) && Number.isFinite(citedEnd)
      && citedStart <= expectedEnd && citedEnd >= expectedStart) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isKnowledgeTask(state: AgentState): boolean {
  return state.taskContract.taskFrame?.effects.knowledgeEvidence === true
    || state.taskContract.evidence.knowledgeSearch;
}

function hasUnresolvedVerificationFailure(state: AgentState): boolean {
  const evidence = state.getCompletionEvidence();
  if (evidence.latestVerification?.success !== false) return false;
  return !evidence.repositoryChanged || evidence.hasVerificationAfterLatestChange;
}
