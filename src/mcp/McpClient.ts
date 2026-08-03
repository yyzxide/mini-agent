import type { McpCallToolResult, McpGetPromptResult, McpReadResourceResult, McpRemotePrompt, McpRemoteResource, McpRemoteTool, McpServerMetadata } from "./McpTypes.js";

export interface McpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, input: unknown): Promise<McpCallToolResult>;
  listResources?(): Promise<McpRemoteResource[]>;
  readResource?(uri: string): Promise<McpReadResourceResult>;
  listPrompts?(): Promise<McpRemotePrompt[]>;
  getPrompt?(name: string, args: Record<string, string>): Promise<McpGetPromptResult>;
  getServerMetadata?(): McpServerMetadata | undefined;
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

export function parseInitializeResult(value: unknown): McpServerMetadata {
  if (!isObject(value) || typeof value.protocolVersion !== "string" || !isObject(value.capabilities)) {
    throw new Error("MCP initialize returned an invalid result");
  }
  if (value.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error(
      `MCP protocol version unsupported: server selected ${value.protocolVersion}; client supports ${MCP_PROTOCOL_VERSION}`,
    );
  }
  const serverInfo = isObject(value.serverInfo)
    && typeof value.serverInfo.name === "string"
    && typeof value.serverInfo.version === "string"
    ? { name: value.serverInfo.name, version: value.serverInfo.version }
    : undefined;
  return {
    protocolVersion: value.protocolVersion,
    capabilities: value.capabilities,
    ...(serverInfo ? { serverInfo } : {}),
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

export function parseCallResult(value: unknown): McpCallToolResult {
  if (!isObject(value)) {
    throw new Error("MCP tools/call returned an invalid result");
  }
  return value as McpCallToolResult;
}

export function parseResourcesList(value: unknown): McpRemoteResource[] {
  if (!isObject(value) || !Array.isArray(value.resources)) throw new Error("MCP resources/list returned an invalid result");
  return value.resources.map((resource) => {
    if (!isObject(resource) || typeof resource.uri !== "string") throw new Error("MCP resources/list returned an invalid descriptor");
    return {
      uri: resource.uri,
      ...(typeof resource.name === "string" ? { name: resource.name } : {}),
      ...(typeof resource.description === "string" ? { description: resource.description } : {}),
      ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
    };
  });
}

export function parseReadResourceResult(value: unknown): McpReadResourceResult {
  if (!isObject(value) || !Array.isArray(value.contents)) throw new Error("MCP resources/read returned an invalid result");
  return {
    contents: value.contents.slice(0, 20).map((content) => {
      if (!isObject(content) || typeof content.uri !== "string") throw new Error("MCP resources/read returned invalid content");
      return {
        uri: content.uri,
        ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
        ...(typeof content.text === "string" ? { text: content.text.slice(0, 100_000) } : {}),
        ...(typeof content.blob === "string" ? { blob: content.blob.slice(0, 100_000) } : {}),
      };
    }),
  };
}

export function parsePromptsList(value: unknown): McpRemotePrompt[] {
  if (!isObject(value) || !Array.isArray(value.prompts)) throw new Error("MCP prompts/list returned an invalid result");
  return value.prompts.map((prompt) => {
    if (!isObject(prompt) || typeof prompt.name !== "string") throw new Error("MCP prompts/list returned an invalid descriptor");
    const args = Array.isArray(prompt.arguments)
      ? prompt.arguments.filter(isObject).map((argument) => ({
        name: typeof argument.name === "string" ? argument.name : "",
        ...(typeof argument.description === "string" ? { description: argument.description } : {}),
        ...(typeof argument.required === "boolean" ? { required: argument.required } : {}),
      })).filter((argument) => argument.name.length > 0)
      : undefined;
    return {
      name: prompt.name,
      ...(typeof prompt.description === "string" ? { description: prompt.description } : {}),
      ...(args ? { arguments: args } : {}),
    };
  });
}

export function parseGetPromptResult(value: unknown): McpGetPromptResult {
  if (!isObject(value) || !Array.isArray(value.messages)) throw new Error("MCP prompts/get returned an invalid result");
  return {
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    messages: value.messages.slice(0, 50),
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
