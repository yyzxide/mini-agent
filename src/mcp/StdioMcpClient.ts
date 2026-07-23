import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { sanitizeChildProcessEnv } from "../command/CommandRunner.js";
import type { McpCallToolResult, McpRemoteTool, McpServerConfig } from "./McpTypes.js";
import {
  initializeRequest,
  parseCallResult,
  parseToolsList,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClient,
} from "./McpClient.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class StdioMcpClient implements McpClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private output: Interface | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private connected = false;
  private connection: Promise<void> | undefined;
  private stderrTail = "";

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.connection) {
        this.connection = this.startConnection();
      }
      try {
        await this.connection;
        return;
      } catch (error) {
        await this.close();
        if (attempt === 1) throw error;
      }
    }
  }

  private async startConnection(): Promise<void> {
    if (!this.config.command) throw new Error(`MCP server ${this.config.name} has no stdio command`);

    const child = spawn(this.config.command, this.config.args, {
      cwd: process.cwd(),
      env: sanitizeChildProcessEnv(this.config.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.stderrTail = "";
    this.output = createInterface({ input: child.stdout });
    this.output.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      // Drain stderr so a verbose MCP server cannot deadlock on pipe backpressure,
      // while retaining a bounded diagnostic tail for unexpected exits.
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      const diagnostic = this.stderrTail.trim();
      this.failAll(new Error(
        `MCP server ${this.config.name} exited (${code ?? signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`,
      ));
      this.process = undefined;
      this.connected = false;
      this.connection = undefined;
    });

    await this.request(initializeRequest(this.nextId++));
    this.notify("notifications/initialized");
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
    this.output?.close();
    this.output = undefined;
    const child = this.process;
    this.process = undefined;
    this.connected = false;
    this.connection = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
    return { jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) };
  }

  private request(request: JsonRpcRequest): Promise<unknown> {
    if (!this.process?.stdin.writable) return Promise.reject(new Error(`MCP server ${this.config.name} is not connected`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`MCP request timed out: ${request.method}`));
      }, this.config.timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private notify(method: string): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try { message = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
