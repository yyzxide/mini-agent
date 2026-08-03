import { z } from "zod";
import { WEB_SEARCH_PROVIDER_NAMES } from "../config/AgentConfig.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";
import { createDuckDuckGoSearchProvider } from "./DuckDuckGoSearchProvider.js";
import type {
  WebSearchProviderAdapter,
  WebSearchResult,
} from "./WebSearchProvider.js";
import { runWebSearchPipeline } from "./WebSearchPipeline.js";

export {
  parseDuckDuckGoHtml,
  parseDuckDuckGoLiteHtml,
} from "./DuckDuckGoSearchProvider.js";
export type { WebSearchResult } from "./WebSearchProvider.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;
const CANDIDATE_POOL_MAX = 30;

const WEB_SEARCH_PROVIDERS = ["auto", ...WEB_SEARCH_PROVIDER_NAMES] as const;
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
  candidateCount: number;
  rankingApplied: boolean;
  results: WebSearchResult[];
}

export interface WebSearchToolOptions {
  providers?: WebSearchProviderAdapter[];
  providerOrder?: string[];
}

/**
 * Thin tool boundary over a provider-independent search pipeline. Built-in
 * provider names remain explicit in the public schema, while provider
 * transport/parsing is isolated behind adapters.
 */
export class WebSearchTool implements Tool<WebSearchInput, WebSearchData> {
  readonly name = "web_search";
  readonly description = "Search the public web for general information and return bounded result titles, URLs, and snippets.";
  readonly inputSchema = webSearchInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;
  readonly metadata = {
    category: "web" as const,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };

  private readonly providers: Map<string, WebSearchProviderAdapter>;
  private readonly providerOrder: string[];

  constructor(options: WebSearchToolOptions = {}) {
    const configured = options.providers ?? [
      createDuckDuckGoSearchProvider("duckduckgo_html"),
      createDuckDuckGoSearchProvider("duckduckgo_lite"),
    ];
    this.providers = new Map(configured.map((provider) => [provider.name, provider]));
    this.providerOrder = options.providerOrder ?? configured.map((provider) => provider.name);
  }

  async execute(input: WebSearchInput, _context: ToolContext): Promise<ToolResult<WebSearchData>> {
    const providerOrder = resolveProviderOrder(input.provider, this.providerOrder)
      .map((name) => this.providers.get(name))
      .filter((provider): provider is WebSearchProviderAdapter => provider !== undefined);
    const pipeline = await runWebSearchPipeline({
      query: input.query,
      maxResults: input.maxResults,
      timeoutMs: input.timeoutMs,
      candidatePoolMax: CANDIDATE_POOL_MAX,
      minimumCandidatePoolSize: Math.max(input.maxResults, HARD_MAX_RESULTS),
    }, providerOrder);

    if (pipeline.candidateCount > 0 || pipeline.providerAttempts.some((attempt) => attempt.success)) {
      return toolSuccess({
        query: input.query,
        provider: normalizeReportedProvider(pipeline.provider),
        candidateCount: pipeline.candidateCount,
        rankingApplied: pipeline.rankingApplied,
        results: pipeline.results,
      }, {
        maxResults: input.maxResults,
        candidateCount: pipeline.candidateCount,
        rankingStrategy: pipeline.rankingApplied ? "temporal-authority-rerank" : "provider-order",
        timeoutMs: input.timeoutMs,
        providerAttempts: pipeline.providerAttempts,
      });
    }

    const firstTimeout = pipeline.providerAttempts.find((attempt) =>
      attempt.error?.startsWith("Web search timed out"),
    );
    if (firstTimeout) {
      return toolFailure(
        "WEB_SEARCH_TIMEOUT",
        `Web search provider fallback exhausted within ${String(input.timeoutMs)}ms: ${firstTimeout.error ?? "timeout"}`,
        {
          query: input.query,
          timeoutMs: input.timeoutMs,
          providerAttempts: pipeline.providerAttempts,
        },
      );
    }

    const firstError = pipeline.providerAttempts.find((attempt) => attempt.error);
    return toolFailure("WEB_SEARCH_FAILED", firstError?.error ?? "Web search failed", {
      query: input.query,
      providerAttempts: pipeline.providerAttempts,
    });
  }
}

function resolveProviderOrder(provider: WebSearchProvider, configuredOrder: string[]): string[] {
  return provider === "auto"
    ? configuredOrder
    : [provider];
}

function normalizeReportedProvider(value: string): WebSearchProvider {
  return WEB_SEARCH_PROVIDERS.includes(value as WebSearchProvider)
    ? value as WebSearchProvider
    : "auto";
}
