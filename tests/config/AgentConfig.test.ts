import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initAgentConfig,
  loadAgentConfig,
  redactAgentConfig,
  resolveLlmConfig,
} from "../../src/config/AgentConfig.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-config-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("AgentConfig", () => {
  it("loads a minimal config when .mini-agent/config.json does not exist", async () => {
    const config = await loadAgentConfig(tempRoot);

    expect(config.version).toBe(1);
    expect(config.repoPath).toBe(tempRoot);
    expect(config.llm).toBeUndefined();
  });

  it("writes and resolves real-model config from .mini-agent/config.json", async () => {
    await initAgentConfig(tempRoot, {
      llm: {
        mode: "real",
        baseUrl: "https://llm.example/v1",
        apiKey: "secret-key",
        model: "agent-model",
        temperature: 0.1,
        maxTokens: 2048,
        timeoutMs: 30000,
      },
    });

    const loaded = await loadAgentConfig(tempRoot);
    const resolved = resolveLlmConfig(loaded);

    expect(resolved).toEqual({
      mode: "real",
      openai: {
        baseUrl: "https://llm.example/v1",
        apiKey: "secret-key",
        model: "agent-model",
        temperature: 0.1,
        maxTokens: 2048,
        timeoutMs: 30000,
      },
    });
  });

  it("lets CLI overrides select mock even when config defaults to real", async () => {
    await initAgentConfig(tempRoot, {
      llm: {
        mode: "real",
        apiKey: "secret-key",
        model: "agent-model",
      },
    });

    const resolved = resolveLlmConfig(await loadAgentConfig(tempRoot), { mock: true });

    expect(resolved.mode).toBe("mock");
  });

  it("redacts API keys before printing config", async () => {
    const config = await initAgentConfig(tempRoot, {
      llm: {
        mode: "real",
        apiKey: "secret-key",
        model: "agent-model",
      },
    });

    expect(redactAgentConfig(config).llm?.apiKey).toBe("<redacted>");
  });
});
