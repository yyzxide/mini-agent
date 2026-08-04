import {
  resolveBraveSearchApiKey,
  resolveWebSearchProviderOrder,
  type AgentConfig,
} from "../config/AgentConfig.js";
import { createBraveSearchProvider } from "./BraveSearchProvider.js";
import { createDuckDuckGoSearchProvider } from "./DuckDuckGoSearchProvider.js";
import type { WebSearchToolOptions } from "./WebSearchTool.js";

export function createConfiguredWebSearchOptions(
  config: AgentConfig,
): WebSearchToolOptions {
  const configured = config.webSearch;
  const providerOrder = resolveWebSearchProviderOrder(config);
  const brave = configured?.brave;
  const braveApiKey = resolveBraveSearchApiKey(config);

  return {
    providerOrder,
    providers: providerOrder.map((name) => {
      if (name === "brave") {
        return createBraveSearchProvider({
          ...(braveApiKey ? { apiKey: braveApiKey } : {}),
          ...(brave?.endpoint ? { endpoint: brave.endpoint } : {}),
          ...(brave?.country ? { country: brave.country } : {}),
          ...(brave?.searchLang ? { searchLang: brave.searchLang } : {}),
          ...(brave?.safeSearch ? { safeSearch: brave.safeSearch } : {}),
        });
      }
      return createDuckDuckGoSearchProvider(name);
    }),
  };
}
