import { isTemporalSearchQuery, rankWebSearchResults } from "./WebSearchRanking.js";
import type {
  WebSearchProviderAdapter,
  WebSearchResult,
} from "./WebSearchProvider.js";

export interface WebSearchProviderAttempt {
  provider: string;
  success: boolean;
  resultCount: number;
  error?: string;
}

export interface WebSearchPipelineInput {
  query: string;
  maxResults: number;
  timeoutMs: number;
  candidatePoolMax: number;
  minimumCandidatePoolSize: number;
}

export interface WebSearchPipelineResult {
  provider: string;
  candidateCount: number;
  rankingApplied: boolean;
  results: WebSearchResult[];
  providerAttempts: WebSearchProviderAttempt[];
}

export async function runWebSearchPipeline(
  input: WebSearchPipelineInput,
  providers: WebSearchProviderAdapter[],
): Promise<WebSearchPipelineResult> {
  const mergedResults: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const providerAttempts: WebSearchProviderAttempt[] = [];
  let firstSuccessfulProvider: string | undefined;
  let firstProviderWithResults: string | undefined;
  const startedAt = Date.now();

  for (const provider of providers) {
    const remainingTimeoutMs = input.timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) break;
    const attempt = await provider.search({
      query: input.query,
      timeoutMs: remainingTimeoutMs,
    });
    providerAttempts.push({
      provider: provider.name,
      success: attempt.success,
      resultCount: attempt.results.length,
      ...("error" in attempt ? { error: attempt.error } : {}),
    });

    if (!attempt.success) continue;
    firstSuccessfulProvider ??= provider.name;
    if (attempt.results.length > 0) firstProviderWithResults ??= provider.name;

    for (const result of attempt.results) {
      const normalizedUrl = normalizeCandidateUrl(result.url);
      if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);
      mergedResults.push({ ...result, url: normalizedUrl });
      if (mergedResults.length >= input.candidatePoolMax) break;
    }
    if (mergedResults.length >= input.minimumCandidatePoolSize) break;
  }

  const providersWithResults = providerAttempts
    .filter((attempt) => attempt.success && attempt.resultCount > 0)
    .map((attempt) => attempt.provider);
  const provider = providersWithResults.length > 1
    ? "auto"
    : firstProviderWithResults ?? firstSuccessfulProvider ?? "auto";
  const rankingApplied = isTemporalSearchQuery(input.query);
  return {
    provider,
    candidateCount: mergedResults.length,
    rankingApplied,
    results: rankWebSearchResults(mergedResults, input.query).slice(0, input.maxResults),
    providerAttempts,
  };
}

function normalizeCandidateUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}
