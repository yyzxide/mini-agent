import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../../src/session/EventStore.js";
import { SessionStore } from "../../src/session/SessionStore.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

const execFileAsync = promisify(execFile);

let repoPath: string;
let sessionStore: SessionStore;
let eventStore: EventStore;
let sessionId: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-apply-patch-tool-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "demo.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "demo.txt"], { cwd: repoPath });

  sessionStore = new SessionStore({ repoPath });
  eventStore = new EventStore({ repoPath });
  const session = await sessionStore.createSession({ title: "Apply Patch" });
  sessionId = session.sessionId;
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("ApplyPatchTool", () => {
  it("runs through ToolRegistry", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("apply_patch", {
      patch: modifyDemoPatch(),
      checkBeforeApply: true,
    }, {
      repoPath,
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("hello\nworld\n");
  });

  it("rejects non-interactive execution without autoApprove", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("apply_patch", {
      patch: modifyDemoPatch(),
    }, {
      repoPath,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PATCH_PERMISSION_DENIED");
    await expect(fs.readFile(path.join(repoPath, "demo.txt"), "utf8")).resolves.toBe("hello\n");
  });

  it("records patch events and file changes with a session", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("apply_patch", {
      patch: modifyDemoPatch(),
    }, {
      repoPath,
      sessionId,
      sessionStore,
      eventStore,
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    const events = await eventStore.readEvents(sessionId);
    const records = await sessionStore.readRecords(sessionId);

    expect(events.map((event) => event.type)).toContain("PATCH_APPLY_STARTED");
    expect(events.map((event) => event.type)).toContain("PATCH_APPLY_FINISHED");
    expect(records.map((record) => record.type)).toContain("FILE_CHANGE");
  });

  it("records PATCH_APPLY_FAILED when git apply fails", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("apply_patch", {
      patch: invalidPatch(),
    }, {
      repoPath,
      sessionId,
      sessionStore,
      eventStore,
      autoApprove: true,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    const events = await eventStore.readEvents(sessionId);
    expect(events.map((event) => event.type)).toContain("PATCH_APPLY_FAILED");
  });
});

function invalidPatch(): string {
  return [
    "diff --git a/demo.txt b/demo.txt",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1,2 @@",
    " not-the-current-line",
    "+world",
    "",
  ].join("\n");
}

function modifyDemoPatch(): string {
  return [
    "diff --git a/demo.txt b/demo.txt",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1,2 @@",
    " hello",
    "+world",
    "",
  ].join("\n");
}
