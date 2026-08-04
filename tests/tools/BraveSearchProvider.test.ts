import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBraveSearchProvider,
  parseBraveSearchResponse,
} from "../../src/tools/BraveSearchProvider.js";
import { createConfiguredToolRegistry } from "../../src/mcp/McpRegistryLoader.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BraveSearchProvider", () => {
  it("normalizes official Brave web result fields", () => {
    expect(parseBraveSearchResponse({
      web: {
        results: [
          {
            title: "<strong>Mini Agent</strong>",
            url: "https://example.com/agent",
            description: "A <em>bounded</em> coding agent.",
          },
          { title: "missing URL" },
        ],
      },
    })).toEqual([{
      title: "Mini Agent",
      url: "https://example.com/agent",
      snippet: "A bounded coding agent.",
    }]);
  });

  it("sends the configured token and bounded Web Search parameters", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.origin + parsed.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
      expect(parsed.searchParams.get("q")).toBe("mini agent");
      expect(parsed.searchParams.get("count")).toBe("20");
      expect(parsed.searchParams.get("result_filter")).toBe("web");
      expect(parsed.searchParams.get("country")).toBe("CN");
      expect(new Headers(init?.headers).get("x-subscription-token")).toBe("brave-secret");
      return new Response(JSON.stringify({
        web: { results: [{ title: "Result", url: "https://example.com", description: "Evidence" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = createBraveSearchProvider({
      apiKey: "brave-secret",
      country: "CN",
      safeSearch: "strict",
      fetchFn,
    });

    await expect(provider.search({ query: "mini agent", timeoutMs: 1_000 })).resolves.toEqual({
      success: true,
      results: [{ title: "Result", url: "https://example.com", snippet: "Evidence" }],
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("returns a precise configuration failure when the API key is absent", async () => {
    const provider = createBraveSearchProvider({});
    await expect(provider.search({ query: "test", timeoutMs: 1_000 })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("BRAVE_SEARCH_API_KEY"),
      results: [],
    });
  });

  it("connects mini-agent.config.json provider order to the registered web_search tool", async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-brave-search-"));
    await fs.writeFile(path.join(repoPath, "mini-agent.config.json"), JSON.stringify({
      version: 1,
      webSearch: {
        providerOrder: ["brave"],
        brave: { apiKey: "configured-key" },
      },
    }), "utf8");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-subscription-token")).toBe("configured-key");
      return new Response(JSON.stringify({
        web: { results: [{ title: "Configured", url: "https://example.com/configured", description: "Result" }] },
      }), { status: 200 });
    }));

    const loaded = await createConfiguredToolRegistry(repoPath);
    try {
      const result = await loaded.registry.execute("web_search", {
        query: "configured provider",
        provider: "auto",
      }, { repoPath });
      expect(result).toMatchObject({
        success: true,
        data: {
          provider: "brave",
          results: [{ title: "Configured", url: "https://example.com/configured", snippet: "Result" }],
        },
      });
    } finally {
      await loaded.registry.dispose();
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
