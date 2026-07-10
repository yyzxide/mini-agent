import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { MiniAgentError } from "../utils/errors.js";
import {
  appendJsonLine,
  ensureDir,
  normalizeRepoPath,
  pathExists,
  readJsonFile,
  readJsonLines,
  resolveMiniAgentPath,
  writeJsonFileAtomic,
} from "../utils/fs.js";
import type {
  CreateSessionInput,
  JsonObject,
  MiniAgentConfig,
  SessionIndex,
  SessionMeta,
  SessionRecord,
  SessionRecordInput,
  SessionStatus,
  AgentOperatingMode,
} from "./SessionTypes.js";

const execFileAsync = promisify(execFile);

export interface SessionStoreOptions {
  repoPath: string;
}

export class SessionStore {
  readonly repoPath: string;

  constructor(options: SessionStoreOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
  }

  async init(): Promise<void> {
    await ensureDir(this.rootPath());
    await ensureDir(this.sessionsDir());
    await ensureDir(this.eventsDir());

    if (!(await pathExists(this.configPath()))) {
      const config: MiniAgentConfig = {
        version: 1,
        repoPath: this.repoPath,
        createdAt: new Date().toISOString(),
      };
      await writeJsonFileAtomic(this.configPath(), config);
    }

    if (!(await pathExists(this.indexPath()))) {
      await this.writeIndex({ version: 1, sessions: [] });
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionMeta> {
    await this.init();

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const meta: SessionMeta = {
      sessionId,
      repoPath: this.repoPath,
      baseCommit: await this.readBaseCommit(),
      title: input.title?.trim() || "Untitled session",
      createdAt: now,
      updatedAt: now,
      status: "ACTIVE",
      messageCount: 0,
      eventCount: 0,
      operatingMode: input.operatingMode ?? "EXECUTE",
    };

    await this.touchFile(this.sessionFilePath(sessionId));
    await this.touchFile(this.eventFilePath(sessionId));

    const index = await this.readIndex();
    await this.writeIndex({
      ...index,
      sessions: [meta, ...index.sessions.filter((session) => session.sessionId !== sessionId)],
    });

    return meta;
  }

  async listSessions(): Promise<SessionMeta[]> {
    await this.init();
    const index = await this.readIndex();

    return index.sessions
      .map(withDefaultOperatingMode)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getSessionMeta(sessionId: string): Promise<SessionMeta> {
    await this.init();
    this.assertValidSessionId(sessionId);

    const index = await this.readIndex();
    const meta = index.sessions.find((session) => session.sessionId === sessionId);

    if (!meta) {
      throw new MiniAgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }

    return withDefaultOperatingMode(meta);
  }

  async appendRecord<TPayload extends JsonObject = JsonObject>(
    sessionId: string,
    input: SessionRecordInput<TPayload>,
  ): Promise<SessionRecord<TPayload>> {
    await this.getSessionMeta(sessionId);

    const record: SessionRecord<TPayload> = {
      id: input.id ?? randomUUID(),
      sessionId,
      type: input.type,
      timestamp: input.timestamp ?? new Date().toISOString(),
      payload: input.payload ?? ({} as TPayload),
    };

    try {
      await appendJsonLine(this.sessionFilePath(sessionId), record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("SESSION_RECORD_WRITE_FAILED", `Failed to append session record: ${message}`, {
        sessionId,
      });
    }

    await this.updateSessionMeta(sessionId, (meta) => ({
      ...meta,
      updatedAt: record.timestamp,
      messageCount: isMessageRecord(record.type) ? meta.messageCount + 1 : meta.messageCount,
    }));

    return record;
  }

  async readRecords(sessionId: string): Promise<SessionRecord[]> {
    await this.getSessionMeta(sessionId);

    try {
      return await readJsonLines<SessionRecord>(this.sessionFilePath(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("SESSION_RECORD_READ_FAILED", message, { sessionId });
    }
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionMeta> {
    await this.getSessionMeta(sessionId);
    const updatedAt = new Date().toISOString();

    return await this.updateSessionMeta(sessionId, (meta) => ({
      ...meta,
      status,
      updatedAt,
    }));
  }

  async updateOperatingMode(sessionId: string, operatingMode: AgentOperatingMode): Promise<SessionMeta> {
    await this.getSessionMeta(sessionId);
    const updatedAt = new Date().toISOString();
    return await this.updateSessionMeta(sessionId, (meta) => ({
      ...meta,
      operatingMode,
      updatedAt,
    }));
  }

  async ensureSession(sessionId?: string): Promise<SessionMeta> {
    if (sessionId) {
      return await this.getSessionMeta(sessionId);
    }

    return await this.createSession();
  }

  private rootPath(): string {
    return resolveMiniAgentPath(this.repoPath);
  }

  private sessionsDir(): string {
    return resolveMiniAgentPath(this.repoPath, "sessions");
  }

  private eventsDir(): string {
    return resolveMiniAgentPath(this.repoPath, "events");
  }

  private configPath(): string {
    return resolveMiniAgentPath(this.repoPath, "config.json");
  }

  private indexPath(): string {
    return resolveMiniAgentPath(this.repoPath, "index.json");
  }

  private sessionFilePath(sessionId: string): string {
    this.assertValidSessionId(sessionId);
    return resolveMiniAgentPath(this.repoPath, "sessions", `${sessionId}.jsonl`);
  }

  private eventFilePath(sessionId: string): string {
    this.assertValidSessionId(sessionId);
    return resolveMiniAgentPath(this.repoPath, "events", `${sessionId}.jsonl`);
  }

  private async touchFile(filePath: string): Promise<void> {
    const handle = await fs.open(filePath, "a");
    await handle.close();
  }

  private async readIndex(): Promise<SessionIndex> {
    return await readJsonFile<SessionIndex>(this.indexPath(), { version: 1, sessions: [] });
  }

  private async writeIndex(index: SessionIndex): Promise<void> {
    try {
      await writeJsonFileAtomic(this.indexPath(), index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("SESSION_INDEX_WRITE_FAILED", `Failed to write session index: ${message}`);
    }
  }

  private async updateSessionMeta(
    sessionId: string,
    updater: (meta: SessionMeta) => SessionMeta,
  ): Promise<SessionMeta> {
    const index = await this.readIndex();
    let updatedMeta: SessionMeta | undefined;

    const sessions = index.sessions.map((session) => {
      if (session.sessionId !== sessionId) {
        return session;
      }

      updatedMeta = updater(session);
      return updatedMeta;
    });

    if (!updatedMeta) {
      throw new MiniAgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }

    await this.writeIndex({ ...index, sessions });
    return updatedMeta;
  }

  private async readBaseCommit(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: this.repoPath,
        encoding: "utf8",
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private assertValidSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) {
      throw new MiniAgentError("INVALID_SESSION_ID", `Invalid session id: ${sessionId}`, { sessionId });
    }
  }
}

function withDefaultOperatingMode(meta: SessionMeta): SessionMeta {
  return { ...meta, operatingMode: meta.operatingMode ?? "EXECUTE" };
}

function isMessageRecord(type: string): boolean {
  return type === "USER_MESSAGE" || type === "ASSISTANT_MESSAGE";
}
