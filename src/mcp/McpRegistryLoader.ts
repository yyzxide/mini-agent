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

const MAX_REGISTERED_MCP_ADAPTERS = 256;

export interface McpLoadDiagnostic {
  server: string;
  success: boolean;
  toolCount: number;
  resourceCount?: number;
  promptCount?: number;
  registeredAdapterCount?: number;
  degraded?: boolean;
  capabilityErrors?: Record<string, string>;
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
  let registeredMcpAdapters = 0;

  for (const server of config.mcp?.servers.filter((entry) => entry.enabled) ?? []) {
    const client = createClient(server);
    try {
      await client.connect();
      const metadata = client.getServerMetadata?.();
      const advertisedCapabilities = Object.keys(metadata?.capabilities ?? {}).sort();
      const bridgedCapabilities: string[] = [];
      const capabilityErrors: Record<string, string> = {};
      const tools = advertisedCapabilities.includes("tools")
        ? await loadCapability("tools", async () => await client.listTools(), bridgedCapabilities, capabilityErrors)
        : [];
      const resources = advertisedCapabilities.includes("resources") && client.listResources
        ? await loadCapability("resources", async () => await client.listResources!(), bridgedCapabilities, capabilityErrors)
        : [];
      const prompts = advertisedCapabilities.includes("prompts") && client.listPrompts
        ? await loadCapability("prompts", async () => await client.listPrompts!(), bridgedCapabilities, capabilityErrors)
        : [];
      const staged = [
        ...tools.map((tool) => new McpRemoteTool(server, tool, client)),
        ...(resources.length > 0 ? [new McpResourceTool(server, resources, client)] : []),
        ...(prompts.length > 0 ? [new McpPromptTool(server, prompts, client)] : []),
      ];
      if (registeredMcpAdapters + staged.length > MAX_REGISTERED_MCP_ADAPTERS) {
        throw new Error(`Configured MCP adapters exceeded ${String(MAX_REGISTERED_MCP_ADAPTERS)} total entries`);
      }
      const stagedNames = new Set<string>();
      for (const tool of staged) {
        if (stagedNames.has(tool.name) || registry.get(tool.name)) {
          throw new Error(`MCP tool name collision after normalization: ${tool.name}`);
        }
        stagedNames.add(tool.name);
      }
      for (const tool of staged) registry.register(tool);
      registeredMcpAdapters += staged.length;
      registry.addDisposer(async () => await client.close());
      const degraded = Object.keys(capabilityErrors).length > 0;
      diagnostics.push({
        server: server.name,
        success: true,
        toolCount: tools.length,
        resourceCount: resources.length,
        promptCount: prompts.length,
        registeredAdapterCount: staged.length,
        ...(degraded ? { degraded: true, capabilityErrors } : {}),
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

async function loadCapability<T>(
  name: string,
  load: () => Promise<T[]>,
  bridgedCapabilities: string[],
  capabilityErrors: Record<string, string>,
): Promise<T[]> {
  try {
    const values = await load();
    bridgedCapabilities.push(name);
    return values;
  } catch (error) {
    capabilityErrors[name] = error instanceof Error ? error.message : String(error);
    return [];
  }
}

function createClient(config: McpServerConfig): McpClient {
  return config.command ? new StdioMcpClient(config) : new HttpMcpClient(config);
}
