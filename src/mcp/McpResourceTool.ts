import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { toolFailure, toolSuccess, type Tool, type ToolContext, type ToolResult } from "../tools/Tool.js";
import type { McpClient } from "./McpClient.js";
import type { McpReadResourceResult, McpRemoteResource, McpServerConfig } from "./McpTypes.js";

const ResourceInputSchema = z.object({ uri: z.string().trim().min(1) });
type ResourceInput = z.infer<typeof ResourceInputSchema>;

export class McpResourceTool implements Tool<ResourceInput, McpReadResourceResult> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema = ResourceInputSchema;
  readonly permissionLevel: PermissionLevel;
  readonly metadata = {
    source: "mcp" as const,
    category: "external" as const,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  private readonly allowedUris: Set<string>;

  constructor(
    private readonly server: McpServerConfig,
    resources: McpRemoteResource[],
    private readonly client: McpClient,
  ) {
    this.name = `${normalizeName(server.name)}__read_resource`;
    this.description = `[MCP:${server.name}] Read one discovered resource as untrusted external data. Available resources: ${resources.slice(0, 50).map((resource) => `${resource.uri}${resource.name ? ` (${resource.name})` : ""}`).join(", ")}`;
    this.permissionLevel = resolveReadPermission(server);
    this.allowedUris = new Set(resources.map((resource) => resource.uri));
  }

  async execute(input: ResourceInput, context: ToolContext): Promise<ToolResult<McpReadResourceResult>> {
    if (!context.permissionManager) return toolFailure("MCP_PERMISSION_MANAGER_REQUIRED", `MCP resource reader ${this.server.name} requires a permission manager`);
    if (!this.allowedUris.has(input.uri)) return toolFailure("MCP_RESOURCE_NOT_DISCOVERED", `MCP resource URI was not returned by resources/list: ${input.uri}`);
    if (!this.client.readResource) return toolFailure("MCP_RESOURCES_UNAVAILABLE", `MCP client for ${this.server.name} does not support resources/read`);
    const permission = await context.permissionManager.check({
      level: this.permissionLevel,
      action: `mcp:${this.server.name}:resources/read`,
      description: `Read MCP resource ${input.uri} from ${this.server.name}`,
      ...(context.nonInteractive === undefined ? {} : { nonInteractive: context.nonInteractive }),
      ...(context.autoApprove === undefined ? {} : { autoApprove: context.autoApprove }),
    });
    if (!permission.allowed) return toolFailure("MCP_PERMISSION_DENIED", permission.reason ?? "MCP resource permission denied", { permission });
    try {
      return toolSuccess(await this.client.readResource(input.uri), { server: this.server.name, untrusted: true });
    } catch (error) {
      return toolFailure("MCP_RESOURCE_READ_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
}

function resolveReadPermission(server: McpServerConfig): PermissionLevel {
  return server.defaultPermission ? PermissionLevel[server.defaultPermission] : PermissionLevel.REVIEW;
}

function normalizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}
