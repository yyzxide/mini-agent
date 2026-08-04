import { z } from "zod";
import { McpServerConfigSchema } from "../mcp/McpTypes.js";
import type { McpServerConfig } from "../mcp/McpTypes.js";
import { pathExists, readJsonFile, resolveMiniAgentPath, resolveRepoPath, writeJsonFileAtomic } from "../utils/fs.js";
import { DEFAULT_MULTI_AGENT_POLICY, type MultiAgentPolicy } from "../agent/SubAgentTypes.js";

export const USER_CONFIG_FILE = "mini-agent.config.json";

export type LlmMode = "real";
export type ThinkingMode = "auto" | "enabled" | "disabled";

export interface LlmConfig {
  mode?: LlmMode | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  thinkingMode?: ThinkingMode | undefined;
  timeoutMs?: number | undefined;
}

export interface RagConfig {
  topK?: number | undefined;
  minScore?: number | undefined;
  maxContextChars?: number | undefined;
}

export const WEB_SEARCH_PROVIDER_NAMES = [
  "brave",
  "duckduckgo_html",
  "duckduckgo_lite",
] as const;

export type WebSearchProviderName = typeof WEB_SEARCH_PROVIDER_NAMES[number];

export interface WebSearchConfig {
  providerOrder?: WebSearchProviderName[] | undefined;
  brave?: {
    apiKey?: string | undefined;
    apiKeyEnv?: string | undefined;
    endpoint?: string | undefined;
    country?: string | undefined;
    searchLang?: string | undefined;
    safeSearch?: "off" | "moderate" | "strict" | undefined;
  } | undefined;
}

export interface MultiAgentConfig {
  mode?: "off" | "auto" | undefined;
  maxConcurrency?: number | undefined;
  maxBatchesPerRun?: number | undefined;
  maxTasksPerRun?: number | undefined;
  maxChildSteps?: number | undefined;
  maxChildLlmCalls?: number | undefined;
  maxChildToolCalls?: number | undefined;
  maxResultChars?: number | undefined;
}

export interface AgentConfig {
  version: 1;
  repoPath?: string | undefined;
  createdAt?: string | undefined;
  llm?: LlmConfig | undefined;
  mcp?: { servers: McpServerConfig[] } | undefined;
  webSearch?: WebSearchConfig | undefined;
  rag?: RagConfig | undefined;
  multiAgent?: MultiAgentConfig | undefined;
}

export interface InitAgentConfigInput {
  llm?: LlmConfig;
  webSearch?: WebSearchConfig;
}

export interface LlmCliOverrides {
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export interface ResolvedLlmConfig {
  mode: LlmMode;
  openai: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    thinkingMode?: ThinkingMode;
    timeoutMs?: number;
  };
}

export function resolveWebSearchProviderOrder(config: AgentConfig): WebSearchProviderName[] {
  return config.webSearch?.providerOrder ?? ["duckduckgo_html", "duckduckgo_lite"];
}

export function resolveBraveSearchApiKey(config: AgentConfig): string | undefined {
  const brave = config.webSearch?.brave;
  return brave?.apiKey
    ?? (brave?.apiKeyEnv ? process.env[brave.apiKeyEnv] : undefined)
    ?? process.env.BRAVE_SEARCH_API_KEY;
}

const llmConfigSchema = z.object({
  mode: z.literal("real").optional(),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  thinkingMode: z.enum(["auto", "enabled", "disabled"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
}).passthrough();

const agentConfigSchema = z.object({
  version: z.literal(1).default(1),
  repoPath: z.string().optional(),
  createdAt: z.string().optional(),
  llm: llmConfigSchema.optional(),
  mcp: z.object({
    servers: z.array(McpServerConfigSchema).default([]),
  }).strict().optional(),
  webSearch: z.object({
    providerOrder: z.array(z.enum(WEB_SEARCH_PROVIDER_NAMES)).min(1)
      .refine((value) => new Set(value).size === value.length, "Web search providerOrder entries must be unique")
      .optional(),
    brave: z.object({
      apiKey: z.string().min(1).optional(),
      apiKeyEnv: z.string().trim().min(1).optional(),
      endpoint: z.string().url().optional(),
      country: z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).optional(),
      searchLang: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/).optional(),
      safeSearch: z.enum(["off", "moderate", "strict"]).optional(),
    }).strict().optional(),
  }).strict().optional(),
  rag: z.object({
    topK: z.number().int().min(1).max(20).optional(),
    minScore: z.number().min(0).max(1).optional(),
    maxContextChars: z.number().int().min(200).max(30_000).optional(),
  }).strict().optional(),
  multiAgent: z.object({
    mode: z.enum(["off", "auto"]).optional(),
    maxConcurrency: z.number().int().min(1).max(3).optional(),
    maxBatchesPerRun: z.number().int().min(1).max(2).optional(),
    maxTasksPerRun: z.number().int().min(2).max(6).optional(),
    maxChildSteps: z.number().int().min(1).max(10).optional(),
    maxChildLlmCalls: z.number().int().min(2).max(40).optional(),
    maxChildToolCalls: z.number().int().min(2).max(60).optional(),
    maxResultChars: z.number().int().min(500).max(20_000).optional(),
  }).strict().optional(),
}).passthrough();

export function resolveMultiAgentPolicy(
  config: AgentConfig,
  agentsOverride?: number,
): MultiAgentPolicy {
  const configured = config.multiAgent ?? {};
  const enabled = agentsOverride === undefined
    ? configured.mode !== "off"
    : agentsOverride > 1;
  const maxConcurrency = agentsOverride
    ?? configured.maxConcurrency
    ?? DEFAULT_MULTI_AGENT_POLICY.maxConcurrency;
  return {
    enabled,
    maxConcurrency,
    maxBatchesPerRun: configured.maxBatchesPerRun ?? DEFAULT_MULTI_AGENT_POLICY.maxBatchesPerRun,
    maxTasksPerRun: configured.maxTasksPerRun ?? DEFAULT_MULTI_AGENT_POLICY.maxTasksPerRun,
    maxChildSteps: configured.maxChildSteps ?? DEFAULT_MULTI_AGENT_POLICY.maxChildSteps,
    maxChildLlmCalls: configured.maxChildLlmCalls ?? DEFAULT_MULTI_AGENT_POLICY.maxChildLlmCalls,
    maxChildToolCalls: configured.maxChildToolCalls ?? DEFAULT_MULTI_AGENT_POLICY.maxChildToolCalls,
    maxResultChars: configured.maxResultChars ?? DEFAULT_MULTI_AGENT_POLICY.maxResultChars,
  };
}

export async function loadAgentConfig(repoPath: string): Promise<AgentConfig> {
  const configPath = await findAgentConfigPath(repoPath);
  if (!configPath) {
    return {
      version: 1,
      repoPath,
    };
  }

  const rawConfig = await readJsonFile<unknown>(configPath, {});
  const parsed = agentConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid ${configPath}${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`);
  }

  const { controlPlane: _removedControlPlane, ...config } = parsed.data;
  return config as AgentConfig;
}

export async function initAgentConfig(repoPath: string, input: InitAgentConfigInput = {}): Promise<AgentConfig> {
  const existing = await loadAgentConfig(repoPath);
  const now = new Date().toISOString();
  const config: AgentConfig = {
    ...existing,
    version: 1,
    repoPath: existing.repoPath ?? repoPath,
    createdAt: existing.createdAt ?? now,
    ...(input.llm ? { llm: normalizeLlmConfig({ ...existing.llm, ...input.llm }) } : {}),
    ...(input.webSearch ? {
      webSearch: normalizeWebSearchConfig({
        ...existing.webSearch,
        ...input.webSearch,
        ...(input.webSearch.brave || existing.webSearch?.brave ? {
          brave: { ...existing.webSearch?.brave, ...input.webSearch.brave },
        } : {}),
      }),
    } : {}),
  };

  await writeJsonFileAtomic(resolveRepoPath(repoPath, USER_CONFIG_FILE), config);
  return config;
}

export function resolveLlmConfig(config: AgentConfig, overrides: LlmCliOverrides = {}): ResolvedLlmConfig {
  const configured = config.llm ?? {};
  const apiKeyFromConfiguredEnv = configured.apiKeyEnv ? process.env[configured.apiKeyEnv] : undefined;
  const openai: ResolvedLlmConfig["openai"] = {};
  const baseUrl = overrides.baseUrl ?? configured.baseUrl ?? process.env.MINI_AGENT_BASE_URL;
  const apiKey = configured.apiKey ?? apiKeyFromConfiguredEnv ?? process.env.MINI_AGENT_API_KEY;
  const model = overrides.model ?? configured.model ?? process.env.MINI_AGENT_MODEL;

  if (baseUrl) {
    openai.baseUrl = baseUrl;
  }

  if (apiKey) {
    openai.apiKey = apiKey;
  }

  if (model) {
    openai.model = model;
  }

  if (configured.temperature !== undefined) {
    openai.temperature = configured.temperature;
  }

  if (configured.maxTokens !== undefined) {
    openai.maxTokens = configured.maxTokens;
  }

  if (configured.thinkingMode !== undefined) {
    openai.thinkingMode = configured.thinkingMode;
  }

  if (configured.timeoutMs !== undefined) {
    openai.timeoutMs = configured.timeoutMs;
  }

  return {
    mode: "real",
    openai,
  };
}

export function redactAgentConfig(config: AgentConfig): AgentConfig {
  if (!config.llm?.apiKey && !config.webSearch?.brave?.apiKey) {
    return config;
  }

  return {
    ...config,
    ...(config.llm?.apiKey ? {
      llm: {
        ...config.llm,
        apiKey: "<redacted>",
      },
    } : {}),
    ...(config.webSearch?.brave?.apiKey ? {
      webSearch: {
        ...config.webSearch,
        brave: {
          ...config.webSearch.brave,
          apiKey: "<redacted>",
        },
      },
    } : {}),
  };
}

function normalizeLlmConfig(config: LlmConfig): LlmConfig {
  const parsed = llmConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid LLM config${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`);
  }

  return parsed.data as LlmConfig;
}

function normalizeWebSearchConfig(config: WebSearchConfig): WebSearchConfig {
  const schema = agentConfigSchema.shape.webSearch.unwrap();
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid Web Search config${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`);
  }
  return parsed.data as WebSearchConfig;
}

async function findAgentConfigPath(repoPath: string): Promise<string | undefined> {
  const userConfigPath = resolveRepoPath(repoPath, USER_CONFIG_FILE);
  if (await pathExists(userConfigPath)) {
    return userConfigPath;
  }

  const legacyConfigPath = resolveMiniAgentPath(repoPath, "config.json");
  if (await pathExists(legacyConfigPath)) {
    return legacyConfigPath;
  }

  return undefined;
}
