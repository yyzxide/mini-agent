import fs from "node:fs/promises";
import process from "node:process";
import type { LogLevel } from "../utils/logger.js";
import { resolveRepoPath } from "../utils/fs.js";
import {
  WEB_SEARCH_PROVIDER_NAMES,
  type ThinkingMode,
  type WebSearchProviderName,
} from "../config/AgentConfig.js";

export function parseOptionalLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

export function parseAgentCount(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 3) throw new Error(`Expected an agent count between 1 and 3, got: ${value}`);
  return parsed;
}

export function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected a positive number, got: ${value}`);
  return parsed;
}

export function parseProbability(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected a number between 0 and 1, got: ${value}`);
  }
  return parsed;
}

export function parseLogLevel(value: string): LogLevel {
  const normalized = value.toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  throw new Error(`Expected log level debug, info, warn, or error, got: ${value}`);
}

export function parseThinkingMode(value: string): ThinkingMode {
  const normalized = value.toLowerCase();
  if (normalized === "auto" || normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  throw new Error(`Expected thinking mode auto, enabled, or disabled, got: ${value}`);
}

export function parseWebSearchProviders(value: string): WebSearchProviderName[] {
  const providers = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (providers.length === 0 || providers.some((provider) => !WEB_SEARCH_PROVIDER_NAMES.includes(provider as WebSearchProviderName))) {
    throw new Error(`Expected a comma-separated provider order using ${WEB_SEARCH_PROVIDER_NAMES.join(", ")}, got: ${value}`);
  }
  if (new Set(providers).size !== providers.length) {
    throw new Error(`Web Search providers must be unique, got: ${value}`);
  }
  return providers as WebSearchProviderName[];
}

export function parseNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got: ${value}`);
  return parsed;
}

export async function readPatchInput(repoPath: string, patchFile?: string): Promise<string> {
  if (patchFile && patchFile.trim().length > 0) {
    return await fs.readFile(resolveRepoPath(repoPath, patchFile), "utf8");
  }
  if (process.stdin.isTTY) throw new Error("Patch file is required when stdin is not piped");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
