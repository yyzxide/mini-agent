import { Command } from "commander";
import { createConfiguredToolRegistry } from "../mcp/McpRegistryLoader.js";
import { PermissionManager } from "../permission/PermissionManager.js";

export function registerMcpCommands(program: Command): void {
  const mcp = program.command("mcp").description("Discover, inspect, and call configured MCP servers");

  mcp.command("tools").description("List local and discovered MCP tools").action(async () => {
    await withRegistry(async (registry) => writeJson(registry.listMcpToolDescriptors()));
  });

  mcp.command("status").description("Connect to configured MCP servers and print diagnostics").action(async () => {
    const loaded = await createConfiguredToolRegistry(process.cwd());
    try { writeJson(loaded.diagnostics); } finally { await loaded.registry.dispose(); }
  });

  mcp.command("call")
    .description("Call a discovered MCP tool by its namespaced registry name")
    .argument("<name>", "Namespaced tool name, for example filesystem__read_file")
    .argument("[jsonInput]", "JSON tool arguments", "{}")
    .action(async (name: string, jsonInput: string) => {
      let input: unknown;
      try { input = JSON.parse(jsonInput); } catch (error) {
        process.exitCode = 1;
        writeJson({ success: false, error: { code: "INVALID_JSON", message: error instanceof Error ? error.message : String(error) } });
        return;
      }
      await withRegistry(async (registry) => {
        const result = await registry.execute(name, input, {
          repoPath: process.cwd(),
          permissionManager: new PermissionManager(),
          nonInteractive: true,
          autoApprove: true,
        });
        if (!result.success) process.exitCode = 1;
        writeJson(result);
      });
    });
}

async function withRegistry(action: (registry: Awaited<ReturnType<typeof createConfiguredToolRegistry>>["registry"]) => Promise<void> | void): Promise<void> {
  const loaded = await createConfiguredToolRegistry(process.cwd());
  try { await action(loaded.registry); } finally { await loaded.registry.dispose(); }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
