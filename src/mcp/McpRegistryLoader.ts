import { loadAgentConfig } from "../config/AgentConfig.js";
import { createDefaultToolRegistry, type ToolRegistry } from "../tools/ToolRegistry.js";
import type { McpClient } from "./McpClient.js";
import { HttpMcpClient } from "./HttpMcpClient.js";
import { McpRemoteTool } from "./McpRemoteTool.js";
import { StdioMcpClient } from "./StdioMcpClient.js";
import type { McpServerConfig } from "./McpTypes.js";

export interface McpLoadDiagnostic {
  server: string;
  success: boolean;
  toolCount: number;
  error?: string;
}

export async function createConfiguredToolRegistry(repoPath: string): Promise<{
  registry: ToolRegistry;
  diagnostics: McpLoadDiagnostic[];
}> {
  const registry = createDefaultToolRegistry();
  const config = await loadAgentConfig(repoPath);
  const diagnostics: McpLoadDiagnostic[] = [];

  for (const server of config.mcp?.servers.filter((entry) => entry.enabled) ?? []) {
    const client = createClient(server);
    try {
      const tools = await client.listTools();
      for (const tool of tools) registry.register(new McpRemoteTool(server, tool, client));
      registry.addDisposer(async () => await client.close());
      diagnostics.push({ server: server.name, success: true, toolCount: tools.length });
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
