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

  it("serializes concurrent index updates across store instances", async () => {
    const creator = new SessionStore({ repoPath });
    const session = await creator.createSession({ title: "Concurrent" });
    const stores = Array.from({ length: 4 }, () => new SessionStore({ repoPath }));

    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      await stores[index % stores.length]!.appendRecord(session.sessionId, {
        type: "USER_MESSAGE",
        payload: { content: `message-${String(index)}` },
      });
    }));

    await expect(creator.readRecords(session.sessionId)).resolves.toHaveLength(20);
    await expect(creator.getSessionMeta(session.sessionId)).resolves.toMatchObject({ messageCount: 20 });
  });

  it("stores private runtime state with owner-only permissions", async () => {
    const store = new SessionStore({ repoPath });
    const session = await store.createSession({ title: "Private" });
    await store.appendRecord(session.sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "secret-adjacent state" },
    });

    if (process.platform !== "win32") {
      const rootMode = (await fs.stat(path.join(repoPath, ".mini-agent"))).mode & 0o777;
      const indexMode = (await fs.stat(path.join(repoPath, ".mini-agent", "index.json"))).mode & 0o777;
      const recordMode = (await fs.stat(path.join(repoPath, ".mini-agent", "sessions", `${session.sessionId}.jsonl`))).mode & 0o777;
      expect(rootMode).toBe(0o700);
      expect(indexMode).toBe(0o600);
      expect(recordMode).toBe(0o600);
    }
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

  it("persists plan operating mode independently from lifecycle status", async () => {
    const store = new SessionStore({ repoPath });
    const session = await store.createSession({ title: "Plan mode" });
    expect(session.operatingMode).toBe("EXECUTE");

    await store.updateOperatingMode(session.sessionId, "PLAN");
    await store.updateSessionStatus(session.sessionId, "PAUSED");

    const reloaded = new SessionStore({ repoPath });
    await expect(reloaded.getSessionMeta(session.sessionId)).resolves.toMatchObject({
      operatingMode: "PLAN",
      status: "PAUSED",
    });
  });
});

async function expectPath(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).resolves.toBeUndefined();
}
