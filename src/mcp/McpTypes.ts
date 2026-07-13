import { z } from "zod";
import type { ToolAnnotations } from "../tools/Tool.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: ToolAnnotations;
  metadata: {
    source: "local" | "mcp";
    permissionLevel: string;
    category?: string;
  };
}

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  defaultPermission: z.enum(["SAFE", "REVIEW", "DANGEROUS"]).default("REVIEW"),
  toolPermissions: z.record(z.string(), z.enum(["SAFE", "REVIEW", "DANGEROUS"])).default({}),
}).strict().superRefine((value, context) => {
  if (!value.command && !value.url) {
    context.addIssue({
      code: "custom",
      message: "MCP server config requires command or url",
      path: ["command"],
    });
  }
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Partial<ToolAnnotations>;
}

export interface McpCallToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}
