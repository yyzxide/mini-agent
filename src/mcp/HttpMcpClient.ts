import type { McpCallToolResult, McpRemoteTool, McpServerConfig } from "./McpTypes.js";
import {
  initializeRequest,
  parseCallResult,
  parseToolsList,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClient,
} from "./McpClient.js";

export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private connected = false;
  private sessionId: string | undefined;
  private connection: Promise<void> | undefined;

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connection) {
      this.connection = this.startConnection();
    }
    try {
      await this.connection;
    } catch (error) {
      this.connection = undefined;
      throw error;
    }
  }

  private async startConnection(): Promise<void> {
    await this.request(initializeRequest(this.nextId++));
    await this.notify("notifications/initialized");
    this.connected = true;
  }

  async listTools(): Promise<McpRemoteTool[]> {
    await this.connect();
    return parseToolsList(await this.request(this.makeRequest("tools/list")));
  }

  async callTool(name: string, input: unknown): Promise<McpCallToolResult> {
    await this.connect();
    return parseCallResult(await this.request(this.makeRequest("tools/call", {
      name,
      arguments: typeof input === "object" && input !== null ? input : {},
    })));
  }

  async close(): Promise<void> {
    try {
      if (this.config.url && this.sessionId) {
        await fetch(this.config.url, {
          method: "DELETE",
          headers: this.headers(),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        }).catch(() => undefined);
      }
    } finally {
      this.connected = false;
      this.sessionId = undefined;
      this.connection = undefined;
    }
  }

  private makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
    return { jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) };
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  private async request(request: JsonRpcRequest): Promise<unknown> {
    const response = await this.post(request);
    if (response.error) throw new Error(`MCP ${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  private async post(message: JsonRpcRequest | { jsonrpc: "2.0"; method: string }): Promise<JsonRpcResponse> {
    if (!this.config.url) throw new Error(`MCP server ${this.config.name} has no HTTP URL`);
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) this.sessionId = returnedSessionId;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await readBoundedText(response)}`);
    if (response.status === 202 || response.status === 204) return { jsonrpc: "2.0" };
    return await parseHttpResponse(response, "id" in message ? message.id : undefined);
  }

  private headers(): Record<string, string> {
    return {
      ...this.config.headers,
      "mcp-protocol-version": "2025-11-25",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }
}

async function parseHttpResponse(response: Response, requestId?: number): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    const body = await readBoundedText(response);
    const messages = body.split(/\r?\n\r?\n/)
      .flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonRpcResponse);
    return messages.find((message) => message.id === requestId) ?? messages.at(-1) ?? { jsonrpc: "2.0" };
  }
  return JSON.parse(await readBoundedText(response)) as JsonRpcResponse;
}

async function readBoundedText(response: Response, maxBytes = 1_000_000): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      const chunk = value.subarray(0, remaining);
      bytes += chunk.length;
      output += decoder.decode(chunk, { stream: bytes < maxBytes });
      if (value.length > remaining) {
        await reader.cancel();
        break;
      }
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}
