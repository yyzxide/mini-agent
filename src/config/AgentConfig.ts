import { z } from "zod";
import { McpServerConfigSchema } from "../mcp/McpTypes.js";
import type { McpServerConfig } from "../mcp/McpTypes.js";
import { pathExists, readJsonFile, resolveMiniAgentPath, resolveRepoPath, writeJsonFileAtomic } from "../utils/fs.js";
import { DEFAULT_MULTI_AGENT_POLICY, type MultiAgentPolicy } from "../agent/SubAgentTypes.js";

export const USER_CONFIG_FILE = "mini-agent.config.json";
export const LEGACY_MINI_AGENT_CONFIG_FILE = ".mini-agent/config.json";

export type LlmMode = "real";

export interface LlmConfig {
  mode?: LlmMode | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface RagConfig {
  topK?: number | undefined;
  minScore?: number | undefined;
  maxContextChars?: number | undefined;
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
  rag?: RagConfig | undefined;
  multiAgent?: MultiAgentConfig | undefined;
}

export interface InitAgentConfigInput {
  llm?: LlmConfig;
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
    timeoutMs?: number;
  };
}

const llmConfigSchema = z.object({
  mode: z.literal("real").optional(),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
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

export function resolveMultiAgentPolicy(config: AgentConfig, agentsOverride?: number): MultiAgentPolicy {
  const configured = config.multiAgent ?? {};
  const enabled = agentsOverride === undefined
    ? configured.mode === "auto"
    : agentsOverride > 1;
  const maxConcurrency = agentsOverride ?? configured.maxConcurrency ?? DEFAULT_MULTI_AGENT_POLICY.maxConcurrency;
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

  return parsed.data as AgentConfig;
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

  if (configured.timeoutMs !== undefined) {
    openai.timeoutMs = configured.timeoutMs;
  }

  return {
    mode: "real",
    openai,
  };
}

export function redactAgentConfig(config: AgentConfig): AgentConfig {
  if (!config.llm?.apiKey) {
    return config;
  }

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: "<redacted>",
    },
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
