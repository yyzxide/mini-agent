import { z } from "zod";
import type { ToolSpec } from "../llm/LlmClient.js";
import {
  errorToCode,
  errorToDetails,
  errorToMessage,
  MiniAgentError,
  ToolInputError,
} from "../utils/errors.js";
import { toJsonValue } from "../utils/json.js";
import type { EventType, JsonObject, SessionRecordType } from "../session/SessionTypes.js";
import { ApplyPatchTool } from "./ApplyPatchTool.js";
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

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  register<TInput, TResult>(tool: Tool<TInput, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new MiniAgentError("TOOL_ALREADY_REGISTERED", `Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
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
        inputSchema: describeInputSchema(tool.inputSchema),
        permissionLevel: tool.permissionLevel,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult<unknown>> {
    const tool = this.tools.get(name);

    if (!tool) {
      return toolFailure("TOOL_NOT_FOUND", `Tool not found: ${name}`, { name });
    }

    const startedResult = await this.recordEvent(context, "TOOL_CALL_STARTED", {
      toolName: name,
      input: toJsonValue(input),
    });
    if (startedResult) {
      return startedResult;
    }

    const callRecordResult = await this.recordSession(context, "TOOL_CALL", {
      toolName: name,
      input: toJsonValue(input),
    });
    if (callRecordResult) {
      return callRecordResult;
    }

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

    const resultRecord = await this.recordSession(context, "TOOL_RESULT", {
      toolName: name,
      success: result.success,
      result: toJsonValue(result.data ?? null),
      error: toJsonValue(result.error ?? null),
      metadata: toJsonValue(result.metadata ?? null),
    });
    if (resultRecord) {
      return resultRecord;
    }

    const finishedEvent = await this.recordEvent(
      context,
      result.success ? "TOOL_CALL_FINISHED" : "TOOL_CALL_FAILED",
      {
        toolName: name,
        success: result.success,
        result: toJsonValue(result.data ?? null),
        error: toJsonValue(result.error ?? null),
        metadata: toJsonValue(result.metadata ?? null),
      },
    );
    if (finishedEvent) {
      return finishedEvent;
    }

    return result;
  }

  private async recordSession(
    context: ToolContext,
    type: SessionRecordType,
    payload: JsonObject,
  ): Promise<ToolResult<never> | undefined> {
    if (!context.sessionId || !context.sessionStore) {
      return undefined;
    }

    try {
      await context.sessionStore.appendRecord(context.sessionId, { type, payload });
      return undefined;
    } catch (error) {
      return toolFailure(errorToCode(error, "SESSION_RECORD_WRITE_FAILED"), errorToMessage(error), errorToDetails(error));
    }
  }

  private async recordEvent(
    context: ToolContext,
    type: EventType,
    payload: JsonObject,
  ): Promise<ToolResult<never> | undefined> {
    if (!context.sessionId || !context.eventStore) {
      return undefined;
    }

    try {
      await context.eventStore.appendEvent(context.sessionId, { type, payload });
      return undefined;
    } catch (error) {
      return toolFailure(errorToCode(error, "EVENT_WRITE_FAILED"), errorToMessage(error), errorToDetails(error));
    }
  }
}

function describeInputSchema(schema: z.ZodType<unknown>): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return {
      type: schema.constructor.name,
    };
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(new ApplyPatchTool());
  registry.register(new FetchUrlTool());
  registry.register(new GitDiffTool());
  registry.register(new GitStatusTool());
  registry.register(new ListFilesTool());
  registry.register(new ReadFileTool());
  registry.register(new SearchCodeTool());
  registry.register(new WebSearchTool());

  return registry;
}
