import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { toolFailure, toolSuccess, type Tool, type ToolContext, type ToolResult } from "../tools/Tool.js";
import type { McpClient } from "./McpClient.js";
import type { McpRemoteTool as RemoteToolDescriptor, McpServerConfig } from "./McpTypes.js";

export class McpRemoteTool implements Tool<unknown, unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema = z.unknown();
  readonly inputJsonSchema: unknown;
  readonly permissionLevel: PermissionLevel;
  readonly metadata;

  constructor(
    private readonly server: McpServerConfig,
    private readonly remote: RemoteToolDescriptor,
    private readonly client: McpClient,
  ) {
    this.name = `${normalizeName(server.name)}__${normalizeName(remote.name)}`;
    this.description = `[MCP:${server.name}] ${remote.description ?? remote.name}`;
    this.inputJsonSchema = remote.inputSchema;
    this.permissionLevel = resolvePermission(server, remote);
    this.metadata = {
      source: "mcp" as const,
      category: "external" as const,
      ...(remote.annotations ? { annotations: remote.annotations } : {}),
    };
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult<unknown>> {
    const permission = await context.permissionManager?.check({
      level: this.permissionLevel,
      action: `mcp:${this.server.name}:${this.remote.name}`,
      description: this.description,
      ...(context.nonInteractive === undefined ? {} : { nonInteractive: context.nonInteractive }),
      ...(context.autoApprove === undefined ? {} : { autoApprove: context.autoApprove }),
      requiresExplicitApproval: this.permissionLevel === PermissionLevel.DANGEROUS,
    });
    if (permission && !permission.allowed) {
      return toolFailure("MCP_PERMISSION_DENIED", permission.reason ?? "MCP tool call denied", { permission });
    }

    try {
      const result = await this.client.callTool(this.remote.name, input);
      if (result.isError) return toolFailure("MCP_TOOL_ERROR", `MCP tool ${this.remote.name} returned an error`, result);
      return toolSuccess(result, { server: this.server.name, remoteTool: this.remote.name, source: "mcp" });
    } catch (error) {
      return toolFailure("MCP_CALL_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
}

function resolvePermission(server: McpServerConfig, tool: RemoteToolDescriptor): PermissionLevel {
  const configured = server.toolPermissions[tool.name] ?? server.defaultPermission;
  if (configured) return PermissionLevel[configured];
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true
    ? PermissionLevel.SAFE
    : PermissionLevel.REVIEW;
}

function normalizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}
