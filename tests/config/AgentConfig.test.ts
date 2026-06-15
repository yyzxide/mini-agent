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
  it("loads a minimal config when no config file exists", async () => {
    const config = await loadAgentConfig(tempRoot);

    expect(config.version).toBe(1);
    expect(config.repoPath).toBe(tempRoot);
    expect(config.llm).toBeUndefined();
  });

  it("writes and resolves real-model config from mini-agent.config.json", async () => {
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
    const configFile = await fs.readFile(path.join(tempRoot, "mini-agent.config.json"), "utf8");

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
    expect(configFile).toContain("secret-key");
  });

  it("loads legacy .mini-agent/config.json when root config is not present", async () => {
    await fs.mkdir(path.join(tempRoot, ".mini-agent"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, ".mini-agent", "config.json"), JSON.stringify({
      version: 1,
      llm: {
        mode: "real",
        baseUrl: "https://legacy.example/v1",
        apiKey: "legacy-key",
        model: "legacy-model",
      },
    }), "utf8");

    const resolved = resolveLlmConfig(await loadAgentConfig(tempRoot));

    expect(resolved).toEqual({
      mode: "real",
      openai: {
        baseUrl: "https://legacy.example/v1",
        apiKey: "legacy-key",
        model: "legacy-model",
      },
    });
  });

  it("prefers root config over legacy .mini-agent/config.json", async () => {
    await fs.mkdir(path.join(tempRoot, ".mini-agent"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, ".mini-agent", "config.json"), JSON.stringify({
      version: 1,
      llm: {
        mode: "real",
        apiKey: "legacy-key",
        model: "legacy-model",
      },
    }), "utf8");
    await fs.writeFile(path.join(tempRoot, "mini-agent.config.json"), JSON.stringify({
      version: 1,
      llm: {
        mode: "real",
        apiKey: "root-key",
        model: "root-model",
      },
    }), "utf8");

    const resolved = resolveLlmConfig(await loadAgentConfig(tempRoot));

    expect(resolved.openai.apiKey).toBe("root-key");
    expect(resolved.openai.model).toBe("root-model");
  });

  it("uses environment variables as real-model fallback values", async () => {
    await initAgentConfig(tempRoot, {
      llm: {
        mode: "real",
        baseUrl: "https://llm.example/v1",
      },
    });

    const oldApiKey = process.env.MINI_AGENT_API_KEY;
    const oldModel = process.env.MINI_AGENT_MODEL;
    process.env.MINI_AGENT_API_KEY = "env-key";
    process.env.MINI_AGENT_MODEL = "env-model";

    try {
      const resolved = resolveLlmConfig(await loadAgentConfig(tempRoot));

      expect(resolved).toEqual({
        mode: "real",
        openai: {
          baseUrl: "https://llm.example/v1",
          apiKey: "env-key",
          model: "env-model",
        },
      });
    } finally {
      restoreEnv("MINI_AGENT_API_KEY", oldApiKey);
      restoreEnv("MINI_AGENT_MODEL", oldModel);
    }
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
