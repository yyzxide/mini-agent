import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeLogger, readRuntimeLogs, redactSecrets } from "../../src/utils/logger.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-logger-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("RuntimeLogger", () => {
  it("writes and reads JSONL runtime logs", async () => {
    const logger = createRuntimeLogger(tempRoot);
    await logger.info("test", "hello log", { value: 1 }, "session-1");

    const logs = await readRuntimeLogs(tempRoot);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "info",
      component: "test",
      message: "hello log",
      sessionId: "session-1",
      details: { value: 1 },
    });
  });

  it("redacts common secret fields and bearer tokens", () => {
    const redacted = redactSecrets({
      apiKey: "secret-key",
      nested: {
        authorization: "Bearer abc.def",
        text: "MINI_AGENT_API_KEY=secret-value",
      },
    });

    expect(redacted).toEqual({
      apiKey: "<redacted>",
      nested: {
        authorization: "<redacted>",
        text: "MINI_AGENT_API_KEY=<redacted>",
      },
    });
  });

  it("preserves numeric token telemetry while still redacting token credentials", () => {
    expect(redactSecrets({
      promptTokens: 1200,
      cacheReadTokens: 900,
      accessToken: "secret-token",
    })).toEqual({
      promptTokens: 1200,
      cacheReadTokens: 900,
      accessToken: "<redacted>",
    });
  });
});
