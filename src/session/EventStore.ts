import { randomUUID } from "node:crypto";
import { MiniAgentError } from "../utils/errors.js";
import {
  appendJsonLine,
  ensureDir,
  normalizeRepoPath,
  readJsonFile,
  readJsonLines,
  resolveMiniAgentPath,
  writeJsonFileAtomic,
} from "../utils/fs.js";
import type {
  EventRecord,
  EventRecordInput,
  JsonObject,
  SessionIndex,
} from "./SessionTypes.js";

export interface EventStoreOptions {
  repoPath: string;
  onEvent?: (event: EventRecord) => void | Promise<void>;
}

export class EventStore {
  readonly repoPath: string;
  private readonly onEvent: ((event: EventRecord) => void | Promise<void>) | undefined;

  constructor(options: EventStoreOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.onEvent = options.onEvent;
  }

  async init(): Promise<void> {
    await ensureDir(resolveMiniAgentPath(this.repoPath));
    await ensureDir(resolveMiniAgentPath(this.repoPath, "events"));
  }

  async appendEvent<TPayload extends JsonObject = JsonObject>(
    sessionId: string,
    input: EventRecordInput<TPayload>,
  ): Promise<EventRecord<TPayload>> {
    await this.init();
    await this.requireSession(sessionId);

    const event: EventRecord<TPayload> = {
      id: input.id ?? randomUUID(),
      sessionId,
      type: input.type,
      timestamp: input.timestamp ?? new Date().toISOString(),
      payload: input.payload ?? ({} as TPayload),
    };

    try {
      await appendJsonLine(this.eventFilePath(sessionId), event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("EVENT_WRITE_FAILED", `Failed to append event: ${message}`, { sessionId });
    }

    await this.incrementEventCount(sessionId, event.timestamp);
    await this.onEvent?.(event);
    return event;
  }

  async readEvents(sessionId: string): Promise<EventRecord[]> {
    await this.init();
    await this.requireSession(sessionId);

    try {
      return await readJsonLines<EventRecord>(this.eventFilePath(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MiniAgentError("EVENT_READ_FAILED", message, { sessionId });
    }
  }

  async tailEvents(sessionId: string, limit = 50): Promise<EventRecord[]> {
    const events = await this.readEvents(sessionId);
    return events.slice(-Math.max(0, limit));
  }

  async countEvents(sessionId: string): Promise<number> {
    const events = await this.readEvents(sessionId);
    return events.length;
  }

  private eventFilePath(sessionId: string): string {
    this.assertValidSessionId(sessionId);
    return resolveMiniAgentPath(this.repoPath, "events", `${sessionId}.jsonl`);
  }

  private indexPath(): string {
    return resolveMiniAgentPath(this.repoPath, "index.json");
  }

  private async readIndex(): Promise<SessionIndex> {
    return await readJsonFile<SessionIndex>(this.indexPath(), { version: 1, sessions: [] });
  }

  private async requireSession(sessionId: string): Promise<void> {
    this.assertValidSessionId(sessionId);
    const index = await this.readIndex();

    if (!index.sessions.some((session) => session.sessionId === sessionId)) {
      throw new MiniAgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }
  }

  private async incrementEventCount(sessionId: string, updatedAt: string): Promise<void> {
    const index = await this.readIndex();
    let found = false;

    const sessions = index.sessions.map((session) => {
      if (session.sessionId !== sessionId) {
        return session;
      }

      found = true;
      return {
        ...session,
        updatedAt,
        eventCount: session.eventCount + 1,
      };
    });

    if (!found) {
      throw new MiniAgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }

    await writeJsonFileAtomic(this.indexPath(), { ...index, sessions });
  }

  private assertValidSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) {
      throw new MiniAgentError("INVALID_SESSION_ID", `Invalid session id: ${sessionId}`, { sessionId });
    }
  }
}
