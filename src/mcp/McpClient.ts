import type { McpCallToolResult, McpGetPromptResult, McpReadResourceResult, McpRemotePrompt, McpRemoteResource, McpRemoteTool, McpServerMetadata } from "./McpTypes.js";
import type { ToolAnnotations } from "../tools/Tool.js";

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
const MAX_MCP_LIST_PAGES = 100;
const MAX_MCP_LIST_ITEMS = 128;
const MAX_MCP_NAME_CHARS = 128;
const MAX_MCP_DESCRIPTION_CHARS = 2_000;
const MAX_MCP_URI_CHARS = 4_096;
const MAX_MCP_SCHEMA_CHARS = 16_000;
const MAX_MCP_PROMPT_ARGUMENTS = 64;

export interface McpListPage<T> {
  items: T[];
  nextCursor?: string;
}

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

export function parseToolsListPage(value: unknown): McpListPage<McpRemoteTool> {
  if (!isObject(value) || !Array.isArray(value.tools)) {
    throw new Error("MCP tools/list returned an invalid result");
  }
  assertListItemCount(value.tools, "MCP tools/list");

  const items = value.tools.map((tool) => {
    if (!isObject(tool) || !("inputSchema" in tool) || !isObject(tool.inputSchema)) {
      throw new Error("MCP tools/list returned an invalid tool descriptor");
    }
    assertJsonSize(tool.inputSchema, MAX_MCP_SCHEMA_CHARS, "MCP tool inputSchema");
    const annotations = parseToolAnnotations(tool.annotations);
    return {
      name: requiredBoundedString(tool.name, MAX_MCP_NAME_CHARS, "MCP tool name"),
      ...optionalBoundedString(tool.description, MAX_MCP_DESCRIPTION_CHARS, "MCP tool description", "description"),
      inputSchema: tool.inputSchema,
      ...(annotations ? { annotations } : {}),
    } satisfies McpRemoteTool;
  });
  return { items, ...parseNextCursor(value) };
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
      ? {
        name: requiredBoundedString(value.serverInfo.name, MAX_MCP_NAME_CHARS, "MCP server name"),
        version: requiredBoundedString(value.serverInfo.version, MAX_MCP_NAME_CHARS, "MCP server version"),
      }
      : undefined;
  assertJsonSize(value.capabilities, MAX_MCP_SCHEMA_CHARS, "MCP server capabilities");
  return {
    protocolVersion: value.protocolVersion,
    capabilities: value.capabilities,
    ...(serverInfo ? { serverInfo } : {}),
    ...optionalBoundedString(value.instructions, MAX_MCP_DESCRIPTION_CHARS, "MCP server instructions", "instructions"),
  };
}

export function parseCallResult(value: unknown): McpCallToolResult {
  if (!isObject(value)) {
    throw new Error("MCP tools/call returned an invalid result");
  }
  return value as McpCallToolResult;
}

export function parseResourcesListPage(value: unknown): McpListPage<McpRemoteResource> {
  if (!isObject(value) || !Array.isArray(value.resources)) throw new Error("MCP resources/list returned an invalid result");
  assertListItemCount(value.resources, "MCP resources/list");
  const items = value.resources.map((resource) => {
    if (!isObject(resource)) throw new Error("MCP resources/list returned an invalid descriptor");
    return {
      uri: requiredBoundedString(resource.uri, MAX_MCP_URI_CHARS, "MCP resource URI"),
      ...optionalBoundedString(resource.name, MAX_MCP_NAME_CHARS, "MCP resource name", "name"),
      ...optionalBoundedString(resource.description, MAX_MCP_DESCRIPTION_CHARS, "MCP resource description", "description"),
      ...optionalBoundedString(resource.mimeType, MAX_MCP_NAME_CHARS, "MCP resource MIME type", "mimeType"),
    };
  });
  return { items, ...parseNextCursor(value) };
}

export function parseReadResourceResult(value: unknown): McpReadResourceResult {
  if (!isObject(value) || !Array.isArray(value.contents)) throw new Error("MCP resources/read returned an invalid result");
  return {
    contents: value.contents.slice(0, 20).map((content) => {
      if (!isObject(content) || typeof content.uri !== "string") throw new Error("MCP resources/read returned invalid content");
      return {
        uri: requiredBoundedString(content.uri, MAX_MCP_URI_CHARS, "MCP resource content URI"),
        ...optionalBoundedString(content.mimeType, MAX_MCP_NAME_CHARS, "MCP resource content MIME type", "mimeType"),
        ...(typeof content.text === "string" ? { text: content.text.slice(0, 100_000) } : {}),
        ...(typeof content.blob === "string" ? { blob: content.blob.slice(0, 100_000) } : {}),
      };
    }),
  };
}

export function parsePromptsListPage(value: unknown): McpListPage<McpRemotePrompt> {
  if (!isObject(value) || !Array.isArray(value.prompts)) throw new Error("MCP prompts/list returned an invalid result");
  assertListItemCount(value.prompts, "MCP prompts/list");
  const items = value.prompts.map((prompt) => {
    if (!isObject(prompt)) throw new Error("MCP prompts/list returned an invalid descriptor");
    if (Array.isArray(prompt.arguments) && prompt.arguments.length > MAX_MCP_PROMPT_ARGUMENTS) {
      throw new Error(`MCP prompt arguments exceeded ${String(MAX_MCP_PROMPT_ARGUMENTS)} items`);
    }
    const args = Array.isArray(prompt.arguments)
      ? prompt.arguments.filter(isObject).map((argument) => ({
        name: requiredBoundedString(argument.name, MAX_MCP_NAME_CHARS, "MCP prompt argument name"),
        ...optionalBoundedString(argument.description, MAX_MCP_DESCRIPTION_CHARS, "MCP prompt argument description", "description"),
        ...(typeof argument.required === "boolean" ? { required: argument.required } : {}),
      }))
      : undefined;
    return {
      name: requiredBoundedString(prompt.name, MAX_MCP_NAME_CHARS, "MCP prompt name"),
      ...optionalBoundedString(prompt.description, MAX_MCP_DESCRIPTION_CHARS, "MCP prompt description", "description"),
      ...(args ? { arguments: args } : {}),
    };
  });
  return { items, ...parseNextCursor(value) };
}

export function parseGetPromptResult(value: unknown): McpGetPromptResult {
  if (!isObject(value) || !Array.isArray(value.messages)) throw new Error("MCP prompts/get returned an invalid result");
  assertJsonSize(value.messages, 200_000, "MCP prompt messages");
  return {
    ...optionalBoundedString(value.description, MAX_MCP_DESCRIPTION_CHARS, "MCP prompt result description", "description"),
    messages: value.messages.slice(0, 50),
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function collectMcpPages<T>(
  fetchPage: (cursor?: string) => Promise<McpListPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MCP_LIST_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    if (items.length + result.items.length > MAX_MCP_LIST_ITEMS) {
      throw new Error(`MCP list pagination exceeded ${String(MAX_MCP_LIST_ITEMS)} items`);
    }
    items.push(...result.items);
    if (!result.nextCursor) return items;
    if (seenCursors.has(result.nextCursor)) {
      throw new Error(`MCP list pagination repeated cursor: ${result.nextCursor}`);
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`MCP list pagination exceeded ${String(MAX_MCP_LIST_PAGES)} pages`);
}

function parseNextCursor(value: Record<string, unknown>): { nextCursor?: string } {
  if (value.nextCursor === undefined || value.nextCursor === null || value.nextCursor === "") return {};
  return { nextCursor: requiredBoundedString(value.nextCursor, MAX_MCP_URI_CHARS, "MCP nextCursor") };
}

function requiredBoundedString(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is missing or invalid`);
  if (value.length > maxChars) throw new Error(`${label} exceeded ${String(maxChars)} characters`);
  return value;
}

function optionalBoundedString<K extends string>(
  value: unknown,
  maxChars: number,
  label: string,
  key: K,
): { [P in K]?: string } {
  if (value === undefined || value === null) return {};
  return { [key]: requiredBoundedString(value, maxChars, label) } as { [P in K]?: string };
}

function assertJsonSize(value: unknown, maxChars: number, label: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not serializable`);
  }
  if (serialized === undefined || serialized.length > maxChars) {
    throw new Error(`${label} exceeded ${String(maxChars)} serialized characters`);
  }
}

function assertListItemCount(values: unknown[], label: string): void {
  if (values.length > MAX_MCP_LIST_ITEMS) {
    throw new Error(`${label} exceeded ${String(MAX_MCP_LIST_ITEMS)} items`);
  }
}

function parseToolAnnotations(value: unknown): Partial<ToolAnnotations> | undefined {
  if (!isObject(value)) return undefined;
  const annotations: Partial<ToolAnnotations> = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof value[key] === "boolean") annotations[key] = value[key];
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
