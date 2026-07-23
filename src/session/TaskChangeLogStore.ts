import { randomUUID } from "node:crypto";
import { MiniAgentError } from "../utils/errors.js";
import {
  appendJsonLine,
  ensureDir,
  readJsonLines,
  resolveMiniAgentPath,
} from "../utils/fs.js";
import { toJsonValue } from "../utils/json.js";
import type { JsonValue } from "./SessionTypes.js";

export type TaskChangeMode = "DIRECT_ANSWER" | "WEB_ANSWER" | "CODE_REVIEW" | "AGENT_LOOP" | "PLAN";

export interface TaskChangeLogEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  task: string;
  mode: TaskChangeMode;
  success: boolean;
  summary: string;
  currentChangedFiles: string[];
  newlyChangedFiles: string[];
  diffStat: string | null;
  tests: TaskChangeTestResult[];
  error?: string;
  metadata?: JsonValue;
}

export interface TaskChangeTestResult {
  type: "TEST_PASSED" | "TEST_FAILED";
  command: string;
  exitCode: number | null;
}

export interface AppendTaskChangeLogInput {
  sessionId: string;
  task: string;
  mode: TaskChangeMode;
  success: boolean;
  summary: string;
  beforeChangedFiles?: string[];
  currentChangedFiles?: string[];
  diffStat?: string | null;
  tests?: TaskChangeTestResult[];
  error?: string;
  metadata?: unknown;
}

export interface TaskChangeLogStoreOptions {
  repoPath: string;
}

export class TaskChangeLogStore {
  private readonly repoPath: string;

  constructor(options: TaskChangeLogStoreOptions) {
    this.repoPath = options.repoPath;
  }

  async append(input: AppendTaskChangeLogInput): Promise<TaskChangeLogEntry> {
    await ensureDir(resolveMiniAgentPath(this.repoPath), 0o700);
    const currentChangedFiles = sortUnique(input.currentChangedFiles ?? []);
    const beforeChangedFiles = new Set(input.beforeChangedFiles ?? []);
    const entry: TaskChangeLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      task: input.task,
      mode: input.mode,
      success: input.success,
      summary: input.summary,
      currentChangedFiles,
      newlyChangedFiles: currentChangedFiles.filter((file) => !beforeChangedFiles.has(file)),
      diffStat: input.diffStat ?? null,
      tests: input.tests ?? [],
      ...(input.error ? { error: input.error } : {}),
      ...(input.metadata === undefined ? {} : { metadata: toJsonValue(input.metadata) }),
    };

    try {
      await appendJsonLine(this.filePath(), entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("CHANGE_LOG_WRITE_FAILED", `Failed to append task change log: ${message}`, {
        sessionId: input.sessionId,
      });
    }

    return entry;
  }

  async list(limit = 50): Promise<TaskChangeLogEntry[]> {
    try {
      const records = await readJsonLines<TaskChangeLogEntry>(this.filePath());
      return records.slice(-Math.max(0, limit)).reverse();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private filePath(): string {
    return resolveMiniAgentPath(this.repoPath, "change-log.jsonl");
  }
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
