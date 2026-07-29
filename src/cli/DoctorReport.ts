import process from "node:process";
import { execa } from "execa";
import { loadAgentConfig, redactAgentConfig, resolveLlmConfig } from "../config/AgentConfig.js";
import { RepoStateAnalyzer } from "../context/RepoStateAnalyzer.js";
import { SessionStore } from "../session/SessionStore.js";
import { TaskChangeLogStore } from "../session/TaskChangeLogStore.js";
import type { JsonObject } from "../session/SessionTypes.js";
import { errorToMessage } from "../utils/errors.js";
import { toJsonObject } from "../utils/json.js";
import { readRuntimeLogs } from "../utils/logger.js";

export async function buildDoctorReport(repoPath: string): Promise<JsonObject> {
  const [gitVersion, rgVersion, pnpmVersion, repoState, configResult, sessions, recentLogs, recentChanges] = await Promise.all([
    readCommandVersion("git", ["--version"]),
    readCommandVersion("rg", ["--version"]),
    readPnpmVersion(),
    new RepoStateAnalyzer({ repoPath }).analyze().catch((error: unknown) => ({ error: errorToMessage(error) })),
    readDoctorConfig(repoPath),
    new SessionStore({ repoPath }).listSessions().catch(() => []),
    readRuntimeLogs(repoPath, { limit: 1 }).catch(() => []),
    new TaskChangeLogStore({ repoPath }).list(1).catch(() => []),
  ]);

  return toJsonObject({
    timestamp: new Date().toISOString(),
    repoPath,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    commands: {
      git: gitVersion,
      rg: rgVersion,
      pnpm: pnpmVersion,
    },
    config: configResult,
    repository: repoState,
    storage: {
      sessionCount: sessions.length,
      latestSession: sessions[0] ?? null,
      hasRuntimeLogs: recentLogs.length > 0,
      hasChangeLog: recentChanges.length > 0,
    },
  });
}

async function readDoctorConfig(repoPath: string): Promise<unknown> {
  try {
    const config = await loadAgentConfig(repoPath);
    const resolved = resolveLlmConfig(config);
    return {
      loaded: true,
      config: redactAgentConfig(config),
      resolved: {
        baseUrl: resolved.openai.baseUrl ?? null,
        model: resolved.openai.model ?? null,
        hasApiKey: Boolean(resolved.openai.apiKey),
        temperature: resolved.openai.temperature ?? null,
        maxTokens: resolved.openai.maxTokens ?? null,
        timeoutMs: resolved.openai.timeoutMs ?? null,
      },
      warnings: [
        resolved.openai.apiKey ? null : "Missing API key. Configure mini-agent.config.json or MINI_AGENT_API_KEY.",
        resolved.openai.model ? null : "Missing model. Configure mini-agent.config.json or MINI_AGENT_MODEL.",
      ].filter(Boolean),
    };
  } catch (error) {
    return {
      loaded: false,
      error: errorToMessage(error),
    };
  }
}

async function readCommandVersion(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execa(command, args, {
      reject: false,
      timeout: 5_000,
      encoding: "utf8",
    });
    return {
      ok: result.exitCode === 0,
      output: firstNonEmptyLine([result.stdout, result.stderr].join("\n")),
    };
  } catch (error) {
    return {
      ok: false,
      output: errorToMessage(error),
    };
  }
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

async function readPnpmVersion(): Promise<{ ok: boolean; output: string }> {
  const direct = await readCommandVersion("pnpm", ["--version"]);
  if (direct.ok) return direct;
  const viaCorepack = await readCommandVersion("corepack", ["pnpm", "--version"]);
  if (viaCorepack.ok) {
    return {
      ok: true,
      output: viaCorepack.output ? `corepack pnpm ${viaCorepack.output}` : "corepack pnpm available",
    };
  }
  return direct.output ? direct : viaCorepack;
}
