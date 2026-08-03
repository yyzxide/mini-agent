import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { McpServerConfigSchema } from "../../src/mcp/McpTypes.js";
import { StdioMcpClient } from "../../src/mcp/StdioMcpClient.js";
import { HttpMcpClient } from "../../src/mcp/HttpMcpClient.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";
import { McpRemoteTool as McpRemoteToolAdapter } from "../../src/mcp/McpRemoteTool.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";
import { collectMcpPages, parseInitializeResult } from "../../src/mcp/McpClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP tool bridge", () => {
  it("exports local tool descriptors with safety annotations", () => {
    const descriptors = createDefaultToolRegistry().listMcpToolDescriptors();

    expect(descriptors).toContainEqual(expect.objectContaining({
      name: "fetch_url",
      annotations: expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      }),
      metadata: expect.objectContaining({
        source: "local",
        category: "web",
        permissionLevel: "REVIEW",
      }),
    }));
  });

  it("validates MCP server config shape", () => {
    expect(McpServerConfigSchema.parse({
      name: "filesystem",
      command: "mcp-server-filesystem",
      args: ["."],
    })).toMatchObject({
      name: "filesystem",
      command: "mcp-server-filesystem",
      args: ["."],
      enabled: true,
    });

    expect(() => McpServerConfigSchema.parse({ name: "broken" })).toThrow();
  });

  it("validates the negotiated initialize result and rejects unsupported protocol versions", () => {
    expect(parseInitializeResult({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fixture", version: "1" },
    })).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
    expect(() => parseInitializeResult({
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} },
    })).toThrow(/protocol version unsupported/i);
  });

  it("rejects repeated pagination cursors instead of looping forever", async () => {
    await expect(collectMcpPages(async () => ({ items: ["item"], nextCursor: "same" })))
      .rejects.toThrow(/repeated cursor/i);
  });

  it("requires an exact interactive approval for a mutating MCP tool", async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { deleted: true } }));
    const client = {
      connect: async () => undefined,
      listTools: async () => [],
      callTool,
      close: async () => undefined,
    };
    const config = McpServerConfigSchema.parse({
      name: "calendar",
      command: "unused-fixture",
      defaultPermission: "REVIEW",
    });
    const tool = new McpRemoteToolAdapter(config, {
      name: "delete_event",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, client);

    const denied = await tool.execute({ id: "event-1" }, {
      repoPath: process.cwd(),
      permissionManager: new PermissionManager(),
      autoApprove: true,
      nonInteractive: true,
    });
    expect(denied).toMatchObject({
      success: false,
      error: { code: "MCP_PERMISSION_DENIED" },
    });
    expect(callTool).not.toHaveBeenCalled();

    const approved = await tool.execute({ id: "event-1" }, {
      repoPath: process.cwd(),
      permissionManager: new PermissionManager({ prompt: async () => "yes" }),
      autoApprove: true,
      nonInteractive: false,
    });
    expect(approved.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith("delete_event", { id: "event-1" });
  });

  it("fails closed when a remote tool is called without a permission manager", async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { ok: true } }));
    const config = McpServerConfigSchema.parse({
      name: "external",
      command: "unused-fixture",
      defaultPermission: "SAFE",
    });
    const tool = new McpRemoteToolAdapter(config, {
      name: "read_data",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, {
      connect: async () => undefined,
      listTools: async () => [],
      callTool,
      close: async () => undefined,
    });

    const result = await tool.execute({}, { repoPath: process.cwd() });

    expect(result).toMatchObject({
      success: false,
      error: { code: "MCP_PERMISSION_MANAGER_REQUIRED" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("discovers and calls tools over a real stdio JSON-RPC process", async () => {
    const config = McpServerConfigSchema.parse({
      name: "fixture",
      command: process.execPath,
      args: [fileURLToPath(new URL("../fixtures/stdio-mcp-server.cjs", import.meta.url))],
      timeoutMs: 5_000,
    });
    const client = new StdioMcpClient(config);
    try {
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "echo", description: "Echo input" }),
      ]);
      await expect(client.callTool("echo", { text: "hello" })).resolves.toMatchObject({
        structuredContent: { echo: "hello" },
      });
      expect(client.getServerMetadata()).toMatchObject({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    } finally {
      await client.close();
    }
  });

  it("supports Streamable HTTP JSON responses and session propagation", async () => {
    const seenSessions: Array<string | undefined> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenSessions.push(headers.get("mcp-session-id") ?? undefined);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { arguments?: unknown; cursor?: string };
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "http", version: "1" } };
      } else if (message.method === "tools/list") {
        result = message.params?.cursor === "tools-2"
          ? { tools: [{ name: "clock", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "tools-2" };
      } else if (message.method === "resources/list") {
        result = message.params?.cursor === "resources-2"
          ? { resources: [{ uri: "docs://faq", name: "FAQ" }] }
          : { resources: [{ uri: "docs://guide", name: "Guide" }], nextCursor: "resources-2" };
      } else if (message.method === "resources/read") {
        result = { contents: [{ uri: "docs://guide", mimeType: "text/plain", text: "External guide" }] };
      } else if (message.method === "prompts/list") {
        result = message.params?.cursor === "prompts-2"
          ? { prompts: [{ name: "summarize" }] }
          : { prompts: [{ name: "review", arguments: [{ name: "target", required: true }] }], nextCursor: "prompts-2" };
      } else if (message.method === "prompts/get") {
        result = { description: "Review prompt", messages: [{ role: "user", content: { type: "text", text: "Review target" } }] };
      } else {
        result = { structuredContent: message.params?.arguments };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "fixture-session",
        },
      });
    }));
    const client = new HttpMcpClient(McpServerConfigSchema.parse({
      name: "http-fixture",
      url: "https://mcp.example.test/mcp",
      timeoutMs: 5_000,
    }));
    try {
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "echo" }),
        expect.objectContaining({ name: "clock" }),
      ]);
      await expect(client.callTool("echo", { value: 42 })).resolves.toMatchObject({ structuredContent: { value: 42 } });
      await expect(client.listResources()).resolves.toEqual([
        expect.objectContaining({ uri: "docs://guide" }),
        expect.objectContaining({ uri: "docs://faq" }),
      ]);
      await expect(client.readResource("docs://guide")).resolves.toMatchObject({ contents: [{ text: "External guide" }] });
      await expect(client.listPrompts()).resolves.toEqual([
        expect.objectContaining({ name: "review" }),
        expect.objectContaining({ name: "summarize" }),
      ]);
      await expect(client.getPrompt("review", { target: "src" })).resolves.toMatchObject({ description: "Review prompt" });
      expect(seenSessions.slice(1)).toEqual(expect.arrayContaining(["fixture-session"]));
      expect(client.getServerMetadata()).toMatchObject({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
    } finally {
      await client.close();
    }
  });
});
