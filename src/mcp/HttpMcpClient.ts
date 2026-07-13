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

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.connected) return;
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
    if (!this.config.url || !this.sessionId) return;
    await fetch(this.config.url, {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }).catch(() => undefined);
    this.connected = false;
    this.sessionId = undefined;
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
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
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
    const body = await response.text();
    const messages = body.split(/\r?\n\r?\n/)
      .flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonRpcResponse);
    return messages.find((message) => message.id === requestId) ?? messages.at(-1) ?? { jsonrpc: "2.0" };
  }
  return await response.json() as JsonRpcResponse;
}
