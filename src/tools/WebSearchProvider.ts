export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProviderRequest {
  query: string;
  timeoutMs: number;
}

export type WebSearchProviderOutcome =
  | { success: true; results: WebSearchResult[] }
  | { success: false; error: string; results: WebSearchResult[] };

/**
 * Provider adapters own only transport and response normalization. Candidate
 * pooling, deduplication, ranking, limits, and factual evidence policy remain
 * in provider-independent layers.
 */
export interface WebSearchProviderAdapter {
  readonly name: string;
  search(request: WebSearchProviderRequest): Promise<WebSearchProviderOutcome>;
}
