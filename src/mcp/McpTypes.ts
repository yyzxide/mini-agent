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
  enabled: z.boolean().default(true),
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
