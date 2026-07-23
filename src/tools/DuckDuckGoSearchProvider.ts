import { formatNetworkError } from "../utils/network.js";
import type {
  WebSearchProviderAdapter,
  WebSearchProviderOutcome,
  WebSearchProviderRequest,
  WebSearchResult,
} from "./WebSearchProvider.js";

export type DuckDuckGoProviderName = "duckduckgo_html" | "duckduckgo_lite";

export function createDuckDuckGoSearchProvider(
  name: DuckDuckGoProviderName,
  fetchFn: typeof fetch = fetch,
): WebSearchProviderAdapter {
  return {
    name,
    search: async (request) => await searchDuckDuckGo(name, request, fetchFn),
  };
}

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const resultBlockPattern = /<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bresult\b|<\/body>|$)/gi;
  const blocks = [...html.matchAll(resultBlockPattern)].map((match) => match[1] ?? "");
  const fallbackBlocks = blocks.length > 0 ? blocks : [html];

  for (const block of fallbackBlocks) {
    const linkMatch = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch?.[1] || !linkMatch[2]) continue;

    const title = htmlToText(linkMatch[2]);
    const url = normalizeDuckDuckGoUrl(decodeHtmlEntities(linkMatch[1]));
    if (!title || !url || results.some((result) => result.url === url)) continue;
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
    if (!linkMatch?.[1] || !linkMatch[2]) continue;
    const title = htmlToText(linkMatch[2]);
    const url = normalizeDuckDuckGoUrl(decodeHtmlEntities(linkMatch[1]));
    if (!title || !url || results.some((result) => result.url === url)) continue;
    results.push({ title, url, snippet: findLiteSnippet(rows, index + 1) });
  }
  return results;
}

async function searchDuckDuckGo(
  provider: DuckDuckGoProviderName,
  request: WebSearchProviderRequest,
  fetchFn: typeof fetch,
): Promise<WebSearchProviderOutcome> {
  const searchUrl = buildSearchUrl(provider, request.query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetchFn(searchUrl, {
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
    const html = await readBoundedText(response, 2_000_000);
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
        error: `Web search timed out after ${String(request.timeoutMs)}ms`,
        results: [],
      };
    }
    return {
      success: false,
      error: formatNetworkError(error, "Web search failed"),
      results: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      const chunk = value.subarray(0, remaining);
      bytes += chunk.length;
      output += decoder.decode(chunk, { stream: bytes < maxBytes });
      if (value.length > remaining) {
        await reader.cancel();
        break;
      }
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function buildSearchUrl(provider: DuckDuckGoProviderName, query: string): URL {
  const url = new URL(provider === "duckduckgo_lite"
    ? "https://lite.duckduckgo.com/lite/"
    : "https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  return url;
}

function normalizeDuckDuckGoUrl(value: string): string {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : parsed.toString();
  } catch {
    return value;
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
    if (!snippetMatch?.[1]) continue;
    const text = htmlToText(snippetMatch[1]);
    if (text.length > 0) return text;
  }
  return "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
