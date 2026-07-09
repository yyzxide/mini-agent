import { z } from "zod";
import type { McpToolDescriptor } from "./McpTypes.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolAnnotations } from "../tools/Tool.js";

export function toMcpToolDescriptor(tool: Tool<unknown, unknown>, inputSchema: unknown): McpToolDescriptor {
  const metadata = tool.metadata ?? {};
  const source = metadata.source ?? "local";
  const category = metadata.category;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    annotations: resolveToolAnnotations(tool),
    metadata: {
      source,
      permissionLevel: tool.permissionLevel,
      ...(category ? { category } : {}),
    },
  };
}

export function resolveToolAnnotations(tool: Pick<Tool<unknown, unknown>, "permissionLevel" | "metadata">): ToolAnnotations {
  const defaults = defaultAnnotations(tool.permissionLevel);
  return {
    ...defaults,
    ...(tool.metadata?.annotations ?? {}),
  };
}

export function describeZodInputSchema(schema: z.ZodType<unknown>): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return {
      type: schema.constructor.name,
    };
  }
}

function defaultAnnotations(permissionLevel: PermissionLevel): ToolAnnotations {
  switch (permissionLevel) {
    case PermissionLevel.SAFE:
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      };
    case PermissionLevel.REVIEW:
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      };
    case PermissionLevel.DANGEROUS:
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
    default:
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
  }
}
