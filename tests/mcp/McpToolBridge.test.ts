import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerConfigSchema } from "../../src/mcp/McpTypes.js";
import { StdioMcpClient } from "../../src/mcp/StdioMcpClient.js";
import { HttpMcpClient } from "../../src/mcp/HttpMcpClient.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

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

  it("discovers and calls tools over a real stdio JSON-RPC process", async () => {
    const serverCode = [
      "const readline=require('node:readline').createInterface({input:process.stdin});",
      "readline.on('line',(line)=>{const message=JSON.parse(line);if(message.id===undefined)return;",
      "let result={};",
      "if(message.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};",
      "if(message.method==='tools/list')result={tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}}]};",
      "if(message.method==='tools/call')result={content:[{type:'text',text:message.params.arguments.text}],structuredContent:{echo:message.params.arguments.text}};",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');});",
    ].join("");
    const config = McpServerConfigSchema.parse({
      name: "fixture",
      command: process.execPath,
      args: ["-e", serverCode],
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
        params?: { arguments?: unknown };
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { structuredContent: message.params?.arguments };
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
      await expect(client.listTools()).resolves.toEqual([expect.objectContaining({ name: "echo" })]);
      await expect(client.callTool("echo", { value: 42 })).resolves.toMatchObject({ structuredContent: { value: 42 } });
      expect(seenSessions.slice(1)).toEqual(expect.arrayContaining(["fixture-session"]));
    } finally {
      await client.close();
    }
  });
});
