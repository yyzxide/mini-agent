import { loadAgentConfig } from "../config/AgentConfig.js";
import { createDefaultToolRegistry, type ToolRegistry } from "../tools/ToolRegistry.js";
import type { McpClient } from "./McpClient.js";
import { HttpMcpClient } from "./HttpMcpClient.js";
import { McpRemoteTool } from "./McpRemoteTool.js";
import { McpResourceTool } from "./McpResourceTool.js";
import { McpPromptTool } from "./McpPromptTool.js";
import { StdioMcpClient } from "./StdioMcpClient.js";
import type { McpServerConfig } from "./McpTypes.js";
import { createConfiguredWebSearchOptions } from "../tools/ConfiguredWebSearch.js";

export interface McpLoadDiagnostic {
  server: string;
  success: boolean;
  toolCount: number;
  resourceCount?: number;
  promptCount?: number;
  registeredAdapterCount?: number;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  advertisedCapabilities?: string[];
  bridgedCapabilities?: string[];
  unbridgedCapabilities?: string[];
  error?: string;
}

export async function createConfiguredToolRegistry(repoPath: string): Promise<{
  registry: ToolRegistry;
  diagnostics: McpLoadDiagnostic[];
}> {
  const config = await loadAgentConfig(repoPath);
  const registry = createDefaultToolRegistry({
    webSearch: createConfiguredWebSearchOptions(config),
  });
  const diagnostics: McpLoadDiagnostic[] = [];

  for (const server of config.mcp?.servers.filter((entry) => entry.enabled) ?? []) {
    const client = createClient(server);
    try {
      await client.connect();
      const metadata = client.getServerMetadata?.();
      const advertisedCapabilities = Object.keys(metadata?.capabilities ?? {}).sort();
      const tools = advertisedCapabilities.includes("tools") ? await client.listTools() : [];
      const resources = advertisedCapabilities.includes("resources") && client.listResources
        ? await client.listResources()
        : [];
      const prompts = advertisedCapabilities.includes("prompts") && client.listPrompts
        ? await client.listPrompts()
        : [];
      const staged = [
        ...tools.map((tool) => new McpRemoteTool(server, tool, client)),
        ...(resources.length > 0 ? [new McpResourceTool(server, resources, client)] : []),
        ...(prompts.length > 0 ? [new McpPromptTool(server, prompts, client)] : []),
      ];
      const stagedNames = new Set<string>();
      for (const tool of staged) {
        if (stagedNames.has(tool.name) || registry.get(tool.name)) {
          throw new Error(`MCP tool name collision after normalization: ${tool.name}`);
        }
        stagedNames.add(tool.name);
      }
      for (const tool of staged) registry.register(tool);
      registry.addDisposer(async () => await client.close());
      const bridgedCapabilities = [
        ...(advertisedCapabilities.includes("tools") ? ["tools"] : []),
        ...(advertisedCapabilities.includes("resources") ? ["resources"] : []),
        ...(advertisedCapabilities.includes("prompts") ? ["prompts"] : []),
      ];
      diagnostics.push({
        server: server.name,
        success: true,
        toolCount: tools.length,
        resourceCount: resources.length,
        promptCount: prompts.length,
        registeredAdapterCount: staged.length,
        ...(metadata ? { protocolVersion: metadata.protocolVersion } : {}),
        ...(metadata?.serverInfo ? { serverInfo: metadata.serverInfo } : {}),
        advertisedCapabilities,
        bridgedCapabilities,
        unbridgedCapabilities: advertisedCapabilities.filter((capability) => !bridgedCapabilities.includes(capability)),
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      diagnostics.push({
        server: server.name,
        success: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { registry, diagnostics };
}

function createClient(config: McpServerConfig): McpClient {
  return config.command ? new StdioMcpClient(config) : new HttpMcpClient(config);
}
