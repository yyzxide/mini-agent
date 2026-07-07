import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;

const WEB_SEARCH_PROVIDERS = ["auto", "duckduckgo_html", "duckduckgo_lite"] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  maxResults: z.number().int().positive().max(HARD_MAX_RESULTS).default(DEFAULT_MAX_RESULTS),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  provider: z.enum(WEB_SEARCH_PROVIDERS).default("auto"),
});

type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface WebSearchData {
  query: string;
  provider: WebSearchProvider;
  results: WebSearchResult[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchTool implements Tool<WebSearchInput, WebSearchData> {
  readonly name = "web_search";
  readonly description = "Search the public web for general information and return bounded result titles, URLs, and snippets.";
  readonly inputSchema = webSearchInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;

  async execute(input: WebSearchInput, _context: ToolContext): Promise<ToolResult<WebSearchData>> {
    const providerOrder = resolveProviderOrder(input.provider);
    const mergedResults: WebSearchResult[] = [];
    const seenUrls = new Set<string>();
    const providerAttempts: Array<{
      provider: Exclude<WebSearchProvider, "auto">;
      success: boolean;
      resultCount: number;
      error?: string;
    }> = [];
    let firstSuccessfulProvider: Exclude<WebSearchProvider, "auto"> | undefined;
    let firstProviderWithResults: Exclude<WebSearchProvider, "auto"> | undefined;

    for (const provider of providerOrder) {
      const attempt = await searchWithProvider(provider, input.query, input.timeoutMs);
      providerAttempts.push({
        provider,
        success: attempt.success,
        resultCount: attempt.results.length,
        ...("error" in attempt ? { error: attempt.error } : {}),
      });

      if (!attempt.success) {
        continue;
      }

      firstSuccessfulProvider ??= provider;
      if (attempt.results.length > 0) {
        firstProviderWithResults ??= provider;
      }
      for (const result of attempt.results) {
        if (seenUrls.has(result.url)) {
          continue;
        }

        seenUrls.add(result.url);
        mergedResults.push(result);
        if (mergedResults.length >= input.maxResults) {
          break;
        }
      }

      if (mergedResults.length >= input.maxResults) {
        break;
      }
    }

    if (mergedResults.length > 0 || providerAttempts.some((attempt) => attempt.success)) {
      const provider = input.provider === "auto"
        ? providerAttempts.filter((attempt) => attempt.success && attempt.resultCount > 0).length > 1
          ? "auto"
          : firstProviderWithResults ?? firstSuccessfulProvider ?? "auto"
        : input.provider;

      return toolSuccess({
        query: input.query,
        provider,
        results: mergedResults.slice(0, input.maxResults),
      }, {
        maxResults: input.maxResults,
        timeoutMs: input.timeoutMs,
        providerAttempts,
      });
    }

    const firstTimeout = providerAttempts.find((attempt) => attempt.error?.startsWith("Web search timed out"));
    if (firstTimeout) {
      return toolFailure("WEB_SEARCH_TIMEOUT", firstTimeout.error ?? `Web search timed out after ${input.timeoutMs}ms`, {
        query: input.query,
        timeoutMs: input.timeoutMs,
        providerAttempts,
      });
    }

    const firstError = providerAttempts.find((attempt) => attempt.error);
    return toolFailure("WEB_SEARCH_FAILED", firstError?.error ?? "Web search failed", {
      query: input.query,
      providerAttempts,
    });
  }
}

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const resultBlockPattern = /<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bresult\b|<\/body>|$)/gi;
  const blocks = [...html.matchAll(resultBlockPattern)].map((match) => match[1] ?? "");
  const fallbackBlocks = blocks.length > 0 ? blocks : [html];

  for (const block of fallbackBlocks) {
    const linkMatch = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

    if (!linkMatch?.[1] || !linkMatch[2]) {
      continue;
    }

    const title = htmlToText(linkMatch[2]);
    const url = normalizeSearchUrl(decodeHtmlEntities(linkMatch[1]));
    if (!title || !url || results.some((result) => result.url === url)) {
      continue;
    }

    const snippetMatch = block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      ?? block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);

    results.push({
      title,
      url,
      snippet: snippetMatch?.[1] ? htmlToText(snippetMatch[1]) : "",
    });
  }

  return results;
}

export function parseDuckDuckGoLiteHtml(html: string): WebSearchResult[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1] ?? "");
  const results: WebSearchResult[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? "";
    const linkMatch = row.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch?.[1] || !linkMatch[2]) {
      continue;
    }

    const title = htmlToText(linkMatch[2]);
    const url = normalizeSearchUrl(decodeHtmlEntities(linkMatch[1]));
    if (!title || !url || results.some((result) => result.url === url)) {
      continue;
    }

    const snippet = findLiteSnippet(rows, index + 1);
    results.push({
      title,
      url,
      snippet,
    });
  }

  return results;
}

async function searchWithProvider(
  provider: Exclude<WebSearchProvider, "auto">,
  query: string,
  timeoutMs: number,
): Promise<{ success: true; results: WebSearchResult[] } | { success: false; error: string; results: WebSearchResult[] }> {
  const searchUrl = buildSearchUrl(provider, query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(searchUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": "mini-coding-agent/0.1",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Web search failed: ${response.status} ${response.statusText}`,
        results: [],
      };
    }

    const html = await response.text();
    return {
      success: true,
      results: provider === "duckduckgo_lite"
        ? parseDuckDuckGoLiteHtml(html)
        : parseDuckDuckGoHtml(html),
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        success: false,
        error: `Web search timed out after ${timeoutMs}ms`,
        results: [],
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Web search failed",
      results: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSearchUrl(provider: Exclude<WebSearchProvider, "auto">, query: string): URL {
  const url = new URL(provider === "duckduckgo_lite"
    ? "https://lite.duckduckgo.com/lite/"
    : "https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  return url;
}

function resolveProviderOrder(provider: WebSearchProvider): Array<Exclude<WebSearchProvider, "auto">> {
  if (provider === "auto") {
    return ["duckduckgo_html", "duckduckgo_lite"];
  }

  return [provider];
}

function normalizeSearchUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : parsed.toString();
  } catch {
    return url;
  }
}

function htmlToText(html: string): string {
  return normalizeText(decodeHtmlEntities(html).replace(/<[^>]+>/g, " "));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function findLiteSnippet(rows: string[], startIndex: number): string {
  for (let index = startIndex; index < Math.min(rows.length, startIndex + 3); index += 1) {
    const row = rows[index] ?? "";
    const snippetMatch = row.match(/<td[^>]*class="[^"]*(?:result-snippet|result-snippet-body)[^"]*"[^>]*>([\s\S]*?)<\/td>/i)
      ?? row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!snippetMatch?.[1]) {
      continue;
    }

    const text = htmlToText(snippetMatch[1]);
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
