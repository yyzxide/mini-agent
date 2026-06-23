import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  maxResults: z.number().int().positive().max(HARD_MAX_RESULTS).default(DEFAULT_MAX_RESULTS),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
});

type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface WebSearchData {
  query: string;
  provider: "duckduckgo_html";
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
    const searchUrl = new URL("https://duckduckgo.com/html/");
    searchUrl.searchParams.set("q", input.query);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

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
        return toolFailure("WEB_SEARCH_HTTP_ERROR", `Web search failed: ${response.status} ${response.statusText}`, {
          status: response.status,
          statusText: response.statusText,
        });
      }

      const html = await response.text();
      return toolSuccess({
        query: input.query,
        provider: "duckduckgo_html",
        results: parseDuckDuckGoHtml(html).slice(0, input.maxResults),
      }, {
        maxResults: input.maxResults,
        timeoutMs: input.timeoutMs,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return toolFailure("WEB_SEARCH_TIMEOUT", `Web search timed out after ${input.timeoutMs}ms`, {
          query: input.query,
          timeoutMs: input.timeoutMs,
        });
      }

      return toolFailure("WEB_SEARCH_FAILED", error instanceof Error ? error.message : "Web search failed", {
        query: input.query,
      });
    } finally {
      clearTimeout(timeout);
    }
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

    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    results.push({
      title,
      url,
      snippet: snippetMatch?.[1] ? htmlToText(snippetMatch[1]) : "",
    });
  }

  return results;
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
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
