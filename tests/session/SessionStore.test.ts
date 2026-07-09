import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session/SessionStore.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-session-store-"));
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("initializes the .mini-agent directory layout", async () => {
    const store = new SessionStore({ repoPath });

    await store.init();

    await expectPath(path.join(repoPath, ".mini-agent"));
    await expectPath(path.join(repoPath, ".mini-agent", "sessions"));
    await expectPath(path.join(repoPath, ".mini-agent", "events"));
    await expectPath(path.join(repoPath, ".mini-agent", "config.json"));
    await expectPath(path.join(repoPath, ".mini-agent", "index.json"));
  });

  it("creates session and event files", async () => {
    const store = new SessionStore({ repoPath });

    const session = await store.createSession({ title: "Store Test" });

    expect(session.title).toBe("Store Test");
    await expectPath(path.join(repoPath, ".mini-agent", "sessions", `${session.sessionId}.jsonl`));
    await expectPath(path.join(repoPath, ".mini-agent", "events", `${session.sessionId}.jsonl`));
  });

  it("lists sessions by updatedAt descending", async () => {
    const store = new SessionStore({ repoPath });

    const first = await store.createSession({ title: "First" });
    const second = await store.createSession({ title: "Second" });
    await store.appendRecord(first.sessionId, {
      type: "USER_MESSAGE",
      timestamp: "2099-01-01T00:00:00.000Z",
      payload: { content: "newer" },
    });

    const sessions = await store.listSessions();

    expect(sessions[0]?.sessionId).toBe(first.sessionId);
    expect(sessions.some((session) => session.sessionId === second.sessionId)).toBe(true);
  });

  it("appends and reads session records", async () => {
    const store = new SessionStore({ repoPath });
    const session = await store.createSession({ title: "Records" });

    const record = await store.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "hello" },
    });

    const records = await store.readRecords(session.sessionId);
    const meta = await store.getSessionMeta(session.sessionId);

    expect(records).toEqual([record]);
    expect(meta.messageCount).toBe(1);
  });

  it("updates session status", async () => {
    const store = new SessionStore({ repoPath });
    const session = await store.createSession({ title: "Status" });

    const paused = await store.updateSessionStatus(session.sessionId, "PAUSED");
    expect(paused.status).toBe("PAUSED");
    await expect(store.getSessionMeta(session.sessionId)).resolves.toMatchObject({ status: "PAUSED" });

    const updated = await store.updateSessionStatus(session.sessionId, "FINISHED");

    expect(updated.status).toBe("FINISHED");
    await expect(store.getSessionMeta(session.sessionId)).resolves.toMatchObject({ status: "FINISHED" });
  });
});

async function expectPath(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).resolves.toBeUndefined();
}
