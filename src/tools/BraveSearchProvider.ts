import { formatNetworkError } from "../utils/network.js";
import type {
  WebSearchProviderAdapter,
  WebSearchProviderOutcome,
  WebSearchProviderRequest,
  WebSearchResult,
} from "./WebSearchProvider.js";

const DEFAULT_BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESPONSE_BYTES = 2_000_000;

export interface BraveSearchProviderOptions {
  apiKey?: string;
  endpoint?: string;
  country?: string;
  searchLang?: string;
  safeSearch?: "off" | "moderate" | "strict";
  fetchFn?: typeof fetch;
}

export function createBraveSearchProvider(
  options: BraveSearchProviderOptions,
): WebSearchProviderAdapter {
  return {
    name: "brave",
    search: async (request) => await searchBrave(request, options),
  };
}

export function parseBraveSearchResponse(value: unknown): WebSearchResult[] {
  if (!isObject(value)) throw new Error("Brave Search returned a non-object response");
  const web = isObject(value.web) ? value.web : undefined;
  if (!web || !Array.isArray(web.results)) return [];
  const results: WebSearchResult[] = [];
  for (const entry of web.results) {
    if (!isObject(entry) || typeof entry.title !== "string" || typeof entry.url !== "string") continue;
    const title = normalizeText(entry.title);
    const url = entry.url.trim();
    if (!title || !url) continue;
    const snippet = typeof entry.description === "string"
      ? normalizeText(entry.description)
      : "";
    results.push({ title, url, snippet });
  }
  return results;
}

async function searchBrave(
  request: WebSearchProviderRequest,
  options: BraveSearchProviderOptions,
): Promise<WebSearchProviderOutcome> {
  if (!options.apiKey) {
    return {
      success: false,
      error: "Brave Search API key is missing. Configure webSearch.brave.apiKeyEnv or BRAVE_SEARCH_API_KEY.",
      results: [],
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const url = new URL(options.endpoint ?? DEFAULT_BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", "20");
    url.searchParams.set("result_filter", "web");
    url.searchParams.set("text_decorations", "false");
    if (options.country) url.searchParams.set("country", options.country);
    if (options.searchLang) url.searchParams.set("search_lang", options.searchLang);
    if (options.safeSearch) url.searchParams.set("safesearch", options.safeSearch);

    const response = await (options.fetchFn ?? fetch)(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "x-subscription-token": options.apiKey,
        "user-agent": "mini-coding-agent/0.1",
      },
    });
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      return {
        success: false,
        error: `Brave Search failed: ${String(response.status)} ${response.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}`,
        results: [],
      };
    }
    try {
      return { success: true, results: parseBraveSearchResponse(JSON.parse(text) as unknown) };
    } catch (error) {
      return {
        success: false,
        error: `Brave Search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        results: [],
      };
    }
  } catch (error) {
    if (isAbortError(error)) {
      return {
        success: false,
        error: `Web search timed out after ${String(request.timeoutMs)}ms`,
        results: [],
      };
    }
    return { success: false, error: formatNetworkError(error, "Brave Search failed"), results: [] };
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

function normalizeText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
