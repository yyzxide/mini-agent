import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredToolRegistry } from "../../src/mcp/McpRegistryLoader.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpRegistryLoader diagnostics", () => {
  it("reports negotiated, bridged, and unbridged server capabilities", async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-mcp-loader-"));
    await fs.writeFile(path.join(repoPath, "mini-agent.config.json"), JSON.stringify({
      version: 1,
      mcp: {
        servers: [{ name: "fixture", url: "https://mcp.example.test/mcp" }],
      },
    }), "utf8");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { uri?: string; name?: string; arguments?: Record<string, string> };
      };
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === "initialize") {
        result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "fixture-server", version: "2" },
          };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
      } else if (message.method === "resources/list") {
        result = { resources: [{ uri: "docs://guide", name: "Guide", mimeType: "text/markdown" }] };
      } else if (message.method === "prompts/list") {
        result = { prompts: [{ name: "review", description: "Review input" }] };
      } else if (message.method === "resources/read") {
        result = { contents: [{ uri: message.params?.uri, mimeType: "text/markdown", text: "# Remote guide" }] };
      } else if (message.method === "prompts/get") {
        result = {
          description: "Resolved review prompt",
          messages: [{ role: "user", content: { type: "text", text: `Review ${message.params?.arguments?.target ?? "input"}` } }],
        };
      } else {
        result = {};
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const loaded = await createConfiguredToolRegistry(repoPath);
    try {
      expect(loaded.diagnostics).toEqual([{
        server: "fixture",
        success: true,
        toolCount: 1,
        resourceCount: 1,
        promptCount: 1,
        registeredAdapterCount: 3,
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture-server", version: "2" },
        advertisedCapabilities: ["prompts", "resources", "tools"],
        bridgedCapabilities: ["tools", "resources", "prompts"],
        unbridgedCapabilities: [],
      }]);
      expect(loaded.registry.get("fixture__echo")).toBeDefined();
      expect(loaded.registry.get("fixture__read_resource")).toBeDefined();
      expect(loaded.registry.get("fixture__get_prompt")).toBeDefined();
      const permissionManager = new PermissionManager({ prompt: async () => "yes" });
      await expect(loaded.registry.execute("fixture__read_resource", { uri: "docs://guide" }, {
        repoPath,
        permissionManager,
        autoApprove: true,
        nonInteractive: true,
      })).resolves.toMatchObject({
        success: true,
        data: { contents: [{ uri: "docs://guide", text: "# Remote guide" }] },
        metadata: { untrusted: true },
      });
      await expect(loaded.registry.execute("fixture__get_prompt", {
        name: "review",
        arguments: { target: "src" },
      }, {
        repoPath,
        permissionManager,
        autoApprove: true,
        nonInteractive: true,
      })).resolves.toMatchObject({
        success: true,
        data: { messages: [{ role: "user", content: { text: "Review src" } }] },
        metadata: { untrusted: true },
      });
      await expect(loaded.registry.execute("fixture__read_resource", { uri: "docs://unknown" }, {
        repoPath,
        permissionManager,
      })).resolves.toMatchObject({ success: false, error: { code: "MCP_RESOURCE_NOT_DISCOVERED" } });
    } finally {
      await loaded.registry.dispose();
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
