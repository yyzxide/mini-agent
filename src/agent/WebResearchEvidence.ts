import type { AgentState } from "./AgentState.js";
import {
  extractSiteConstraintDomains,
  looksLikeAuthoritativeFreshnessQuery,
  urlMatchesSiteConstraint,
} from "./WebResearchPolicy.js";

export type AuthoritativeFreshnessEvidenceStatus =
  | "NO_AUTHORITY_FRESHNESS_SEARCH"
  | "AUTHORITY_RESULT_NOT_FETCHED"
  | "FETCHED_SOURCE_LACKS_TEMPORAL_EVIDENCE"
  | "SATISFIED";

export interface AuthoritativeFreshnessEvidenceAssessment {
  status: AuthoritativeFreshnessEvidenceStatus;
  authoritativeQueries: string[];
  candidateUrls: string[];
  inspectedUrls: string[];
}

interface SearchEvidence {
  query: string;
  urls: string[];
}

interface FetchedEvidence {
  urls: string[];
  text: string;
}

/**
 * A latest/current claim needs a closed evidence chain:
 *
 * authority/freshness query -> exact returned candidate -> successful fetch ->
 * visible version/date/release evidence.
 *
 * This deliberately does not trust query wording or search-engine rank alone.
 */
export function assessAuthoritativeFreshnessEvidence(
  state: AgentState,
): AuthoritativeFreshnessEvidenceAssessment {
  const authoritativeSearches = readSuccessfulSearches(state)
    .filter((search) => looksLikeAuthoritativeFreshnessQuery(search.query))
    .map((search) => {
      const constrainedDomains = extractSiteConstraintDomains(search.query);
      return {
        ...search,
        urls: search.urls.filter((url) => urlMatchesSiteConstraint(url, constrainedDomains)),
      };
    });
  const authoritativeQueries = unique(authoritativeSearches.map((search) => search.query));
  const candidateUrls = unique(authoritativeSearches.flatMap((search) => search.urls));

  if (authoritativeSearches.length === 0 || candidateUrls.length === 0) {
    return {
      status: "NO_AUTHORITY_FRESHNESS_SEARCH",
      authoritativeQueries,
      candidateUrls,
      inspectedUrls: [],
    };
  }

  const candidateKeys = new Set(candidateUrls.map(normalizeHttpUrl).filter(isString));
  const inspected = readSuccessfulFetches(state).filter((fetch) =>
    fetch.urls.some((url) => {
      const normalized = normalizeHttpUrl(url);
      return normalized !== undefined && candidateKeys.has(normalized);
    }),
  );
  const inspectedUrls = unique(inspected.flatMap((fetch) => fetch.urls));

  if (inspected.length === 0) {
    return {
      status: "AUTHORITY_RESULT_NOT_FETCHED",
      authoritativeQueries,
      candidateUrls,
      inspectedUrls,
    };
  }

  if (!inspected.some((fetch) => containsTemporalReleaseEvidence(fetch.text))) {
    return {
      status: "FETCHED_SOURCE_LACKS_TEMPORAL_EVIDENCE",
      authoritativeQueries,
      candidateUrls,
      inspectedUrls,
    };
  }

  return {
    status: "SATISFIED",
    authoritativeQueries,
    candidateUrls,
    inspectedUrls,
  };
}

function readSuccessfulSearches(state: AgentState): SearchEvidence[] {
  const searches: SearchEvidence[] = [];
  for (const result of state.toolResults) {
    if (result.toolName !== "web_search" || !result.result.success) continue;
    const query = readObjectString(result.input, "query");
    if (!query || !isObject(result.result.data)) continue;
    const entries = result.result.data.results;
    const urls = Array.isArray(entries)
      ? entries
        .map((entry) => readObjectString(entry, "url"))
        .filter(isString)
      : [];
    searches.push({ query, urls: unique(urls) });
  }
  return searches;
}

function readSuccessfulFetches(state: AgentState): FetchedEvidence[] {
  const fetches: FetchedEvidence[] = [];
  for (const result of state.toolResults) {
    if (result.toolName !== "fetch_url" || !result.result.success) continue;
    const inputUrl = readObjectString(result.input, "url");
    const finalUrl = readObjectString(result.result.data, "finalUrl");
    const text = readObjectString(result.result.data, "text") ?? "";
    const urls = unique([inputUrl, finalUrl].filter(isString));
    if (urls.length > 0) fetches.push({ urls, text });
  }
  return fetches;
}

function containsTemporalReleaseEvidence(value: string): boolean {
  const text = value.normalize("NFKC");
  return /(?:最新|当前|发布|推出|上线|更新|版本|型号)|\b(?:latest|current|newest|released?|launch(?:ed|es)?|available|updated?|version|model)\b/i.test(text)
    || /\b(?:19|20)\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)?\b/.test(text)
    || /\b[a-z][a-z0-9]{1,20}[\s_./\-\u2010-\u2015]?\d+(?:\.\d+)+\b/i.test(text);
}

function normalizeHttpUrl(value: string): string | undefined {
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
