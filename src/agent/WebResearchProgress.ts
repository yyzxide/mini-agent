import type { AgentState } from "./AgentState.js";
import { assessAuthoritativeFreshnessEvidence } from "./WebResearchEvidence.js";

export type WebResearchPhase =
  | "DISCOVER"
  | "AUTHORITY_SEARCH"
  | "INSPECT_SOURCE"
  | "COMPARE_EVIDENCE"
  | "SYNTHESIZE";

export type WebResearchRecommendedAction =
  | "WEB_SEARCH"
  | "FETCH_URL"
  | "FINAL"
  | "LIMITATION_FINAL";

export interface WebResearchProgress {
  phase: WebResearchPhase;
  temporalSuperlative: boolean;
  searchViews: number;
  requiredSearchViews: number;
  fetchedSources: number;
  requiredFetchedSources: number;
  fetchedDomains: number;
  requiredFetchedDomains: number;
  authoritySearchSatisfied: boolean;
  authorityCandidateFetched: boolean;
  visibleFreshnessEvidence: boolean;
  citationsAvailable: number;
  evidenceReady: boolean;
  remainingSteps: number;
  synthesisReserved: boolean;
  recommendedAction: WebResearchRecommendedAction;
  authorityCandidateUrls: string[];
}

export interface WebLimitationFinal {
  summary: string;
  success: boolean;
}

const FINAL_SYNTHESIS_RESERVE_STEPS = 2;

export function buildWebResearchProgress(state: AgentState): WebResearchProgress | undefined {
  if (
    !state.taskContract.evidence.webSearch
    && !state.taskContract.capabilities.webAccess
  ) {
    return undefined;
  }

  const temporalSuperlative = state.taskContract.evidence.webFreshnessRequired;
  const authorityRequired = state.taskContract.evidence.webAuthorityRequired;
  const searchQueries = successfulSearchQueries(state);
  const fetchedUrls = successfulFetchedUrls(state);
  const fetchedDomains = new Set(fetchedUrls.map(readDomain).filter(isString));
  const gatheredUrls = new Set([...successfulSearchUrls(state), ...fetchedUrls]);
  const authority = authorityRequired
    ? assessAuthoritativeFreshnessEvidence(state)
    : undefined;
  const requiredSearchViews = state.taskContract.evidence.webSearchViewCount;
  const authoritySearchSatisfied = !authorityRequired
    || authority?.status !== "NO_AUTHORITY_FRESHNESS_SEARCH";
  const authorityCandidateFetched = !authorityRequired
    || (authority?.status !== "NO_AUTHORITY_FRESHNESS_SEARCH"
      && authority?.status !== "AUTHORITY_RESULT_NOT_FETCHED");
  const visibleFreshnessEvidence = !temporalSuperlative
    || !authorityRequired
    || authority?.status === "SATISFIED";
  const searchReady = searchQueries.length >= requiredSearchViews;
  const fetchReady = fetchedUrls.length >= state.taskContract.evidence.fetchedWebSourceCount;
  const domainReady = fetchedDomains.size >= state.taskContract.evidence.independentWebDomainCount;
  const evidenceReady = searchReady
    && fetchReady
    && domainReady
    && authoritySearchSatisfied
    && authorityCandidateFetched
    && visibleFreshnessEvidence;
  const remainingSteps = Math.max(0, state.maxSteps - state.step);
  const synthesisReserved = remainingSteps <= FINAL_SYNTHESIS_RESERVE_STEPS;

  let phase: WebResearchPhase;
  let recommendedAction: WebResearchRecommendedAction;
  if (synthesisReserved) {
    phase = "SYNTHESIZE";
    recommendedAction = evidenceReady ? "FINAL" : "LIMITATION_FINAL";
  } else if (searchQueries.length === 0) {
    phase = "DISCOVER";
    recommendedAction = "WEB_SEARCH";
  } else if (!searchReady || !authoritySearchSatisfied) {
    phase = authorityRequired && !authoritySearchSatisfied ? "AUTHORITY_SEARCH" : "DISCOVER";
    recommendedAction = "WEB_SEARCH";
  } else if (!fetchReady || !domainReady || !authorityCandidateFetched || !visibleFreshnessEvidence) {
    phase = "INSPECT_SOURCE";
    recommendedAction = "FETCH_URL";
  } else {
    phase = "COMPARE_EVIDENCE";
    recommendedAction = "FINAL";
  }

  return {
    phase,
    temporalSuperlative,
    searchViews: searchQueries.length,
    requiredSearchViews,
    fetchedSources: fetchedUrls.length,
    requiredFetchedSources: state.taskContract.evidence.fetchedWebSourceCount,
    fetchedDomains: fetchedDomains.size,
    requiredFetchedDomains: state.taskContract.evidence.independentWebDomainCount,
    authoritySearchSatisfied,
    authorityCandidateFetched,
    visibleFreshnessEvidence,
    citationsAvailable: gatheredUrls.size,
    evidenceReady,
    remainingSteps,
    synthesisReserved,
    recommendedAction,
    authorityCandidateUrls: authority?.candidateUrls.slice(0, 5) ?? [],
  };
}

export function formatWebResearchProgress(progress: WebResearchProgress | undefined): string {
  if (!progress) return "(not a web research task)";
  return [
    `Phase: ${progress.phase}`,
    `Search views: ${String(progress.searchViews)} / ${String(progress.requiredSearchViews)}`,
    `Fetched sources: ${String(progress.fetchedSources)} / ${String(progress.requiredFetchedSources)}`,
    `Fetched domains: ${String(progress.fetchedDomains)} / ${String(progress.requiredFetchedDomains)}`,
    `Authority search: ${formatSatisfied(progress.authoritySearchSatisfied)}`,
    `Authority candidate fetched: ${formatSatisfied(progress.authorityCandidateFetched)}`,
    `Visible freshness evidence: ${formatSatisfied(progress.visibleFreshnessEvidence)}`,
    `Citations available: ${String(progress.citationsAvailable)}`,
    "Higher-version conflict check: enforced when FINAL is evaluated",
    `Evidence ready: ${formatSatisfied(progress.evidenceReady)}`,
    `Remaining decisions: ${String(progress.remainingSteps)}`,
    `Final synthesis reserve active: ${String(progress.synthesisReserved)}`,
    `Required next action: ${progress.recommendedAction}`,
    ...(progress.authorityCandidateUrls.length > 0
      ? ["Exact authority candidates:", ...progress.authorityCandidateUrls.map((url) => `- ${url}`)]
      : []),
    progress.synthesisReserved
      ? "SYNTHESIS RULE: Do not call tools. Return FINAL success=true with grounded citations when evidence is ready; otherwise return FINAL success=false or FAILED with a transparent insufficient-evidence explanation."
      : "Follow Required next action. Never guess or repair a URL.",
  ].join("\n");
}

export function isWebSynthesisReserveActive(state: AgentState): boolean {
  return buildWebResearchProgress(state)?.synthesisReserved === true;
}

/**
 * Deterministic liveness fallback for the final synthesis reserve. The model
 * still writes the substantive draft, but it cannot keep retrying a success
 * claim after the evidence budget is exhausted.
 */
export function buildWebLimitationFinal(
  state: AgentState,
  proposedSummary?: string,
): WebLimitationFinal | undefined {
  const progress = buildWebResearchProgress(state);
  if (
    !progress?.synthesisReserved
    || progress.recommendedAction !== "LIMITATION_FINAL"
  ) {
    return undefined;
  }

  const profile = state.taskContract.taskFrame?.webEvidencePolicy.profile ?? "ORDINARY";
  const inspectedUrls = successfulFetchedUrls(state);
  const discoveredUrls = successfulSearchUrls(state)
    .filter((url) => !inspectedUrls.includes(url));
  const visibleUrls = (inspectedUrls.length > 0 ? inspectedUrls : discoveredUrls).slice(0, 5);
  const draft = proposedSummary?.trim();
  const limitation = [
    "证据限制 / Evidence limitation:",
    `现有证据不足以满足 ${String(progress.requiredFetchedSources)} 个已抓取来源、${String(progress.requiredFetchedDomains)} 个独立域名的完整核验门槛；当前为 ${String(progress.fetchedSources)} 个来源、${String(progress.fetchedDomains)} 个域名。`,
    "以下结论只能作为基于当前可用资料的有限总结，不能视为已经完成多源或时效性核验。",
  ].join(" ");
  const sourceSection = visibleUrls.length > 0
    ? [
      inspectedUrls.length > 0
        ? "已成功检查的来源 / Successfully inspected sources:"
        : "已发现但未能完整抓取的候选来源 / Discovered source candidates:",
      ...visibleUrls.map((url) => `- ${url}`),
    ].join("\n")
    : "本轮没有获得可引用的公开来源 / No citable public source was obtained.";

  return {
    // An ordinary lookup can still be usefully completed with transparent
    // partial evidence. Explicit corroboration/current/high-stakes requests
    // remain unsuccessful when their requested threshold was not met.
    success: profile === "ORDINARY" && progress.citationsAvailable > 0,
    summary: [
      draft || "未能在当前检索条件下形成可充分核验的完整答案。",
      limitation,
      sourceSection,
    ].join("\n\n"),
  };
}

function successfulSearchQueries(state: AgentState): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const result of state.toolResults) {
    if (result.toolName !== "web_search" || !result.result.success) continue;
    const query = readObjectString(result.input, "query");
    if (!query) continue;
    const normalized = query.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    queries.push(query);
  }
  return queries;
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
  return unique(urls);
}

function successfulFetchedUrls(state: AgentState): string[] {
  return unique(state.toolResults
    .filter((result) => result.toolName === "fetch_url" && result.result.success)
    .map((result) =>
      readObjectString(result.result.data, "finalUrl")
      ?? readObjectString(result.input, "url"))
    .filter(isString));
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

function readObjectString(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatSatisfied(value: boolean): "satisfied" | "missing" {
  return value ? "satisfied" : "missing";
}
