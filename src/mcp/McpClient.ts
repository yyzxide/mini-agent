import type { McpCallToolResult, McpRemoteTool } from "./McpTypes.js";

export interface McpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, input: unknown): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export function initializeRequest(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mini-agent", version: "0.1.0" },
    },
  };
}

export function parseToolsList(value: unknown): McpRemoteTool[] {
  if (!isObject(value) || !Array.isArray(value.tools)) {
    throw new Error("MCP tools/list returned an invalid result");
  }

  return value.tools.map((tool) => {
    if (!isObject(tool) || typeof tool.name !== "string" || !("inputSchema" in tool)) {
      throw new Error("MCP tools/list returned an invalid tool descriptor");
    }
    return {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(isObject(tool.annotations) ? { annotations: tool.annotations } : {}),
    } as McpRemoteTool;
  });
}

export function parseCallResult(value: unknown): McpCallToolResult {
  if (!isObject(value)) {
    throw new Error("MCP tools/call returned an invalid result");
  }
  return value as McpCallToolResult;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
