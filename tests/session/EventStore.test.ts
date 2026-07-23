import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../../src/session/EventStore.js";
import { SessionStore } from "../../src/session/SessionStore.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

let repoPath: string;
let sessionStore: SessionStore;
let eventStore: EventStore;
let sessionId: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-event-store-"));
  await fs.writeFile(path.join(repoPath, "README.md"), "# Test Repo\n\nneedle\n", "utf8");

  sessionStore = new SessionStore({ repoPath });
  eventStore = new EventStore({ repoPath });
  const session = await sessionStore.createSession({ title: "Events" });
  sessionId = session.sessionId;
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("EventStore", () => {
  it("appends and reads events", async () => {
    const event = await eventStore.appendEvent(sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "hello" },
    });

    const events = await eventStore.readEvents(sessionId);
    const meta = await sessionStore.getSessionMeta(sessionId);

    expect(events).toEqual([event]);
    expect(meta.eventCount).toBe(1);
  });

  it("tails the last N events", async () => {
    await eventStore.appendEvent(sessionId, { type: "USER_MESSAGE", payload: { index: 1 } });
    await eventStore.appendEvent(sessionId, { type: "ASSISTANT_MESSAGE", payload: { index: 2 } });
    await eventStore.appendEvent(sessionId, { type: "TASK_FINISHED", payload: { index: 3 } });

    const tail = await eventStore.tailEvents(sessionId, 2);

    expect(tail.map((event) => event.payload.index)).toEqual([2, 3]);
    await expect(eventStore.countEvents(sessionId)).resolves.toBe(3);
  });

  it("reports invalid JSONL with a line number", async () => {
    await fs.appendFile(path.join(repoPath, ".mini-agent", "events", `${sessionId}.jsonl`), "{bad json\n", "utf8");

    await expect(eventStore.readEvents(sessionId)).rejects.toMatchObject({
      code: "EVENT_READ_FAILED",
    });
    await expect(eventStore.readEvents(sessionId)).rejects.toThrow(/:1/);
  });

  it("recovers complete events before a trailing partial JSONL write", async () => {
    await eventStore.appendEvent(sessionId, {
      type: "USER_MESSAGE",
      payload: { content: "durable" },
    });
    await fs.appendFile(
      path.join(repoPath, ".mini-agent", "events", `${sessionId}.jsonl`),
      "{\"id\":\"partial",
      "utf8",
    );

    const events = await eventStore.readEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.content).toBe("durable");
  });
});

describe("ToolRegistry session/event integration", () => {
  it("writes started and finished events for successful tools", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", { path: "README.md" }, {
      repoPath,
      sessionId,
      sessionStore,
      eventStore,
    });

    expect(result.success).toBe(true);

    const events = await eventStore.readEvents(sessionId);
    const records = await sessionStore.readRecords(sessionId);

    expect(events.map((event) => event.type)).toEqual(["TOOL_CALL_STARTED", "TOOL_CALL_FINISHED"]);
    expect(records.map((record) => record.type)).toEqual(["TOOL_CALL", "TOOL_RESULT"]);
    expect(JSON.stringify(records.at(-1)?.payload)).toContain("omitted from audit log");
    expect(JSON.stringify(records.at(-1)?.payload)).not.toContain("# Test Repo");
  });

  it("writes failed events for tool failures", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", { path: "../outside.txt" }, {
      repoPath,
      sessionId,
      sessionStore,
      eventStore,
    });

    expect(result.success).toBe(false);

    const events = await eventStore.readEvents(sessionId);
    expect(events.map((event) => event.type)).toEqual(["TOOL_CALL_STARTED", "TOOL_CALL_FAILED"]);
  });
});
