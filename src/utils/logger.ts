import path from "node:path";
import { MiniAgentError } from "./errors.js";
import {
  appendJsonLine,
  ensureDir,
  readJsonLines,
  resolveMiniAgentPath,
} from "./fs.js";
import { toJsonValue } from "./json.js";
import type { JsonObject, JsonValue } from "../session/SessionTypes.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  sessionId?: string;
  details?: JsonValue;
}

export interface RuntimeLoggerOptions {
  repoPath: string;
  level?: LogLevel;
}

export interface ReadRuntimeLogsOptions {
  limit?: number;
  level?: LogLevel;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie)/i;
const SAFE_TOKEN_METRIC_KEY_PATTERN = /^(?:promptTokens|completionTokens|totalTokens|cachedPromptTokens|reasoningTokens|cacheReadTokens|cacheWriteTokens|maxTokens|estimatedTokens|includedTokens|estimatedInputTokens|estimatedOutputTokens)$/;

export class RuntimeLogger {
  private readonly repoPath: string;
  private readonly level: LogLevel;

  constructor(options: RuntimeLoggerOptions) {
    this.repoPath = options.repoPath;
    this.level = options.level ?? readLogLevel();
  }

  async debug(component: string, message: string, details?: unknown, sessionId?: string): Promise<void> {
    await this.write("debug", component, message, details, sessionId);
  }

  async info(component: string, message: string, details?: unknown, sessionId?: string): Promise<void> {
    await this.write("info", component, message, details, sessionId);
  }

  async warn(component: string, message: string, details?: unknown, sessionId?: string): Promise<void> {
    await this.write("warn", component, message, details, sessionId);
  }

  async error(component: string, message: string, details?: unknown, sessionId?: string): Promise<void> {
    await this.write("error", component, message, details, sessionId);
  }

  private async write(
    level: LogLevel,
    component: string,
    message: string,
    details?: unknown,
    sessionId?: string,
  ): Promise<void> {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(details === undefined ? {} : { details: redactSecrets(toJsonValue(details)) }),
    };

    try {
      await ensureDir(logsDir(this.repoPath), 0o700);
      await appendJsonLine(logFilePath(this.repoPath, record.timestamp), record);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("LOG_WRITE_FAILED", `Failed to write runtime log: ${errorMessage}`, {
        component,
        message,
      });
    }
  }
}

export function createRuntimeLogger(repoPath: string): RuntimeLogger {
  return new RuntimeLogger({ repoPath });
}

export async function readRuntimeLogs(
  repoPath: string,
  options: ReadRuntimeLogsOptions = {},
): Promise<LogRecord[]> {
  const limit = options.limit ?? 50;
  const directoryPath = logsDir(repoPath);

  let fileNames: string[];
  try {
    fileNames = await import("node:fs/promises").then((fs) => fs.readdir(directoryPath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const records: LogRecord[] = [];
  for (const fileName of fileNames
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse()) {
    const filePath = path.join(directoryPath, fileName);
    const fileRecords = await readJsonLines<LogRecord>(filePath);
    for (const record of fileRecords.reverse()) {
      if (options.level && record.level !== options.level) {
        continue;
      }

      records.push(record);
      if (records.length >= limit) {
        return records;
      }
    }
  }

  return records;
}

export function redactSecrets(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactSecretString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (typeof value === "object" && value !== null) {
    const output: JsonObject = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) && !SAFE_TOKEN_METRIC_KEY_PATTERN.test(key)
        ? "<redacted>"
        : redactSecrets(nestedValue);
    }
    return output;
  }

  return value;
}

function logsDir(repoPath: string): string {
  return resolveMiniAgentPath(repoPath, "logs");
}

function logFilePath(repoPath: string, isoTimestamp: string): string {
  return path.join(logsDir(repoPath), `${isoTimestamp.slice(0, 10)}.jsonl`);
}

function readLogLevel(): LogLevel {
  const value = process.env.MINI_AGENT_LOG_LEVEL?.toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }

  return "info";
}

function redactSecretString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/(MINI_AGENT_API_KEY\s*=\s*)[^\s]+/g, "$1<redacted>")
    .replace(/("apiKey"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
