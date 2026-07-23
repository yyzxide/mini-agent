import { describe, expect, it } from "vitest";
import { runWebSearchPipeline } from "../../src/tools/WebSearchPipeline.js";
import type { WebSearchProviderAdapter } from "../../src/tools/WebSearchProvider.js";

describe("WebSearchPipeline", () => {
  it("normalizes, deduplicates, and reranks candidates across arbitrary providers", async () => {
    const providers: WebSearchProviderAdapter[] = [
      provider("provider_a", [
        {
          title: "Acme 4.1 release",
          url: "https://acme.example/releases/4-1#details",
          snippet: "April 2, 2026.",
        },
      ]),
      provider("provider_b", [
        {
          title: "Duplicate Acme 4.1 result",
          url: "https://acme.example/releases/4-1",
          snippet: "The same release.",
        },
        {
          title: "Acme 4.2 release",
          url: "https://acme.example/releases/4-2",
          snippet: "July 20, 2026.",
        },
      ]),
    ];

    const result = await runWebSearchPipeline({
      query: "Acme latest model 2026",
      maxResults: 2,
      timeoutMs: 1_000,
      candidatePoolMax: 10,
      minimumCandidatePoolSize: 10,
    }, providers);

    expect(result.provider).toBe("auto");
    expect(result.providerAttempts.map((attempt) => attempt.provider)).toEqual([
      "provider_a",
      "provider_b",
    ]);
    expect(result.candidateCount).toBe(2);
    expect(result.rankingApplied).toBe(true);
    expect(result.results.map((entry) => entry.title)).toEqual([
      "Acme 4.2 release",
      "Acme 4.1 release",
    ]);
  });

  it("continues to another provider after a provider-specific failure", async () => {
    const failed: WebSearchProviderAdapter = {
      name: "failed_provider",
      search: async () => ({ success: false, error: "provider unavailable", results: [] }),
    };
    const fallback = provider("fallback_provider", [
      { title: "Fallback result", url: "https://example.com/result", snippet: "Evidence" },
    ]);

    const result = await runWebSearchPipeline({
      query: "general research",
      maxResults: 5,
      timeoutMs: 1_000,
      candidatePoolMax: 10,
      minimumCandidatePoolSize: 5,
    }, [failed, fallback]);

    expect(result.provider).toBe("fallback_provider");
    expect(result.results).toHaveLength(1);
    expect(result.providerAttempts).toEqual([
      expect.objectContaining({ provider: "failed_provider", success: false }),
      expect.objectContaining({ provider: "fallback_provider", success: true }),
    ]);
  });
});

function provider(
  name: string,
  results: Array<{ title: string; url: string; snippet: string }>,
): WebSearchProviderAdapter {
  return {
    name,
    search: async () => ({ success: true, results }),
  };
}
