import { z } from "zod";
import type { ToolSpec } from "../llm/LlmClient.js";
import type { McpToolDescriptor } from "../mcp/McpTypes.js";
import { describeZodInputSchema, resolveToolAnnotations, toMcpToolDescriptor } from "../mcp/McpToolBridge.js";
import {
  errorToCode,
  errorToDetails,
  errorToMessage,
  MiniAgentError,
  ToolInputError,
} from "../utils/errors.js";
import { toJsonValue } from "../utils/json.js";
import { redactSecrets } from "../utils/logger.js";
import { truncateText } from "../utils/fs.js";
import type { EventType, JsonObject, SessionRecordType } from "../session/SessionTypes.js";
import { ApplyPatchTool } from "./ApplyPatchTool.js";
import { KnowledgeSearchTool } from "../rag/KnowledgeSearchTool.js";
import { FetchUrlTool } from "./FetchUrlTool.js";
import { GitDiffTool } from "./GitDiffTool.js";
import { GitStatusTool } from "./GitStatusTool.js";
import { ListFilesTool } from "./ListFilesTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { SearchCodeTool } from "./SearchCodeTool.js";
import { WebSearchTool } from "./WebSearchTool.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure } from "./Tool.js";

export interface ToolSummary {
  name: string;
  description: string;
  permissionLevel: string;
}

export interface ToolManifestEntry extends ToolSummary {
  source: "local" | "mcp";
  category?: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();
  private readonly disposers: Array<() => Promise<void>> = [];

  register<TInput, TResult>(tool: Tool<TInput, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new MiniAgentError("TOOL_ALREADY_REGISTERED", `Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
  }

  addDisposer(disposer: () => Promise<void>): void {
    this.disposers.push(disposer);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.disposers.splice(0).map(async (dispose) => await dispose()));
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolSummary[] {
    return Array.from(this.tools.values())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        permissionLevel: tool.permissionLevel,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listSpecs(): ToolSpec[] {
    return Array.from(this.tools.values())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputJsonSchema ?? describeZodInputSchema(tool.inputSchema),
        permissionLevel: tool.permissionLevel,
        source: tool.metadata?.source ?? "local",
        annotations: resolveToolAnnotations(tool),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listManifest(): ToolManifestEntry[] {
    return Array.from(this.tools.values())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        permissionLevel: tool.permissionLevel,
        source: tool.metadata?.source ?? "local",
        ...(tool.metadata?.category ? { category: tool.metadata.category } : {}),
        annotations: resolveToolAnnotations(tool),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listMcpToolDescriptors(): McpToolDescriptor[] {
    return Array.from(this.tools.values())
      .map((tool) => toMcpToolDescriptor(tool, tool.inputJsonSchema ?? describeZodInputSchema(tool.inputSchema)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult<unknown>> {
    const tool = this.tools.get(name);

    if (!tool) {
      return toolFailure("TOOL_NOT_FOUND", `Tool not found: ${name}`, { name });
    }

    const auditWarnings: string[] = [];
    await this.recordEvent(context, "TOOL_CALL_STARTED", {
      toolName: name,
      input: redactSecrets(toJsonValue(input)),
    }).catch((error: unknown) => auditWarnings.push(`event-start: ${errorToMessage(error)}`));
    await this.recordSession(context, "TOOL_CALL", {
      toolName: name,
      input: redactSecrets(toJsonValue(input)),
    }).catch((error: unknown) => auditWarnings.push(`session-call: ${errorToMessage(error)}`));

    let result: ToolResult<unknown>;

    try {
      const parsedInput = tool.inputSchema.parse(input);
      result = await tool.execute(parsedInput, context);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const inputError = new ToolInputError("Tool input validation failed", z.treeifyError(error));
        result = toolFailure(inputError.code, inputError.message, inputError.details);
      } else {
        result = toolFailure(errorToCode(error, "TOOL_EXECUTION_FAILED"), errorToMessage(error), errorToDetails(error));
      }
    }

    await this.recordSession(context, "TOOL_RESULT", {
      toolName: name,
      success: result.success,
      result: compactPersistedToolResult(name, result.data ?? null),
      error: redactSecrets(toJsonValue(result.error ?? null)),
      metadata: redactSecrets(toJsonValue(result.metadata ?? null)),
    }).catch((error: unknown) => auditWarnings.push(`session-result: ${errorToMessage(error)}`));

    await this.recordEvent(
      context,
      result.success ? "TOOL_CALL_FINISHED" : "TOOL_CALL_FAILED",
      {
        toolName: name,
        success: result.success,
        resultPreview: auditPreview(result.data ?? null),
        error: redactSecrets(toJsonValue(result.error ?? null)),
        metadata: redactSecrets(toJsonValue(result.metadata ?? null)),
      },
    ).catch((error: unknown) => auditWarnings.push(`event-finish: ${errorToMessage(error)}`));

    return auditWarnings.length === 0
      ? result
      : {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          auditWarnings,
        },
      };
  }

  private async recordSession(
    context: ToolContext,
    type: SessionRecordType,
    payload: JsonObject,
  ): Promise<void> {
    if (!context.sessionId || !context.sessionStore) {
      return;
    }
    await context.sessionStore.appendRecord(context.sessionId, { type, payload });
  }

  private async recordEvent(
    context: ToolContext,
    type: EventType,
    payload: JsonObject,
  ): Promise<void> {
    if (!context.sessionId || !context.eventStore) {
      return;
    }
    await context.eventStore.appendEvent(context.sessionId, { type, payload });
  }
}

function auditPreview(value: unknown): string {
  const json = JSON.stringify(redactSecrets(toJsonValue(value)));
  return truncateText(json, 4_000).text;
}

function compactPersistedToolResult(toolName: string, value: unknown) {
  const redacted = redactSecrets(toJsonValue(value));
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
    return redacted;
  }

  if (toolName === "read_file") {
    const content = typeof redacted.content === "string" ? redacted.content : "";
    return {
      ...redacted,
      content: content.length > 0 ? `[omitted from audit log: ${String(content.length)} chars]` : "",
    };
  }

  if (toolName === "knowledge_search") {
    return {
      found: redacted.found ?? false,
      ...(Array.isArray(redacted.citations) ? { citations: redacted.citations.slice(0, 20) } : {}),
    };
  }

  const serialized = JSON.stringify(redacted);
  return serialized.length <= 4_000
    ? redacted
    : {
      truncated: true,
      resultPreview: truncateText(serialized, 4_000).text,
    };
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(new ApplyPatchTool());
  registry.register(new FetchUrlTool());
  registry.register(new GitDiffTool());
  registry.register(new GitStatusTool());
  registry.register(new KnowledgeSearchTool());
  registry.register(new ListFilesTool());
  registry.register(new ReadFileTool());
  registry.register(new SearchCodeTool());
  registry.register(new WebSearchTool());

  return registry;
}
