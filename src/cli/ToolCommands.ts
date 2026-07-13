import { Command } from "commander";
import { createConfiguredToolRegistry } from "../mcp/McpRegistryLoader.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import type { ToolContext, ToolResult } from "../tools/Tool.js";
import { createRuntimeLogger } from "../utils/logger.js";
import { createStores } from "./CliTaskRuntime.js";

export function registerToolCommands(program: Command): void {
  const tool = program.command("tool").description("Inspect and run local or configured MCP tools");

  tool.command("list").description("List registered tools").action(async () => {
    await withRegistry(async (registry) => writeJson(registry.list()));
  });

  tool.command("manifest").description("List registered tools with capability annotations").action(async () => {
    await withRegistry(async (registry) => writeJson(registry.listManifest()));
  });

  tool.command("run")
    .description("Run a registered tool with JSON input")
    .argument("<name>", "Tool name")
    .argument("[jsonInput]", "Tool input as JSON", "{}")
    .option("--session <sessionId>", "Session id used for event and record logging")
    .action(async (name: string, jsonInput: string, options: { session?: string }) => {
      const parsed = parseJsonInput(jsonInput);
      if (!parsed.success) {
        writeJson(parsed);
        process.exitCode = 1;
        return;
      }

      await withRegistry(async (registry) => {
        const repoPath = process.cwd();
        const stores = options.session ? createStores(repoPath) : undefined;
        const logger = createRuntimeLogger(repoPath);
        if (stores && options.session) {
          await stores.sessionStore.ensureSession(options.session);
          await stores.eventStore.init();
        }
        const context: ToolContext = {
          repoPath,
          permissionManager: new PermissionManager(),
          autoApprove: true,
          nonInteractive: true,
          ...(options.session && stores ? {
            sessionId: options.session,
            sessionStore: stores.sessionStore,
            eventStore: stores.eventStore,
          } : {}),
        };
        await logger.info("tool", "Tool requested", { toolName: name, input: parsed.data }, options.session).catch(() => undefined);
        const result = await registry.execute(name, parsed.data, context);
        await logger[result.success ? "info" : "error"]("tool", "Tool finished", {
          toolName: name,
          success: result.success,
          error: result.error ?? null,
        }, options.session).catch(() => undefined);
        writeJson(result);
      });
    });
}

function parseJsonInput(value: string): ToolResult<unknown> {
  try { return { success: true, data: JSON.parse(value) as unknown }; } catch (error) {
    return {
      success: false,
      error: {
        code: "INVALID_JSON",
        message: `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

async function withRegistry(action: (registry: Awaited<ReturnType<typeof createConfiguredToolRegistry>>["registry"]) => Promise<void>): Promise<void> {
  const loaded = await createConfiguredToolRegistry(process.cwd());
  try { await action(loaded.registry); } finally { await loaded.registry.dispose(); }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
