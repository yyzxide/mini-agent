import { z } from "zod";
import { pathExists, readJsonFile, resolveMiniAgentPath, resolveRepoPath, writeJsonFileAtomic } from "../utils/fs.js";

export const USER_CONFIG_FILE = "mini-agent.config.json";
export const LEGACY_MINI_AGENT_CONFIG_FILE = ".mini-agent/config.json";

export type LlmMode = "mock" | "real";

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

export interface AgentConfig {
  version: 1;
  repoPath?: string | undefined;
  createdAt?: string | undefined;
  llm?: LlmConfig | undefined;
}

export interface InitAgentConfigInput {
  llm?: LlmConfig;
}

export interface LlmCliOverrides {
  mock?: boolean | undefined;
  real?: boolean | undefined;
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
  mode: z.enum(["mock", "real"]).optional(),
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
}).passthrough();

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
  if (overrides.mock && overrides.real) {
    throw new Error("Choose either --mock or --real, not both.");
  }

  const configured = config.llm ?? {};
  const mode = overrides.mock ? "mock" : overrides.real ? "real" : configured.mode ?? "mock";
  const apiKeyFromConfiguredEnv = configured.apiKeyEnv ? process.env[configured.apiKeyEnv] : undefined;
  const openai: ResolvedLlmConfig["openai"] = {};
  const baseUrl = overrides.baseUrl ?? configured.baseUrl;
  const apiKey = configured.apiKey ?? apiKeyFromConfiguredEnv;
  const model = overrides.model ?? configured.model;

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
    mode,
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
