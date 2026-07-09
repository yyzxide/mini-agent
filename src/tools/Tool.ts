import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { PermissionCheckInput, PermissionDecision } from "../permission/PermissionManager.js";
import type { EventRecordInput, SessionRecordInput } from "../session/SessionTypes.js";

export interface ToolSessionRecorder {
  appendRecord(sessionId: string, record: SessionRecordInput): Promise<unknown>;
}

export interface ToolEventRecorder {
  appendEvent(sessionId: string, event: EventRecordInput): Promise<unknown>;
}

export interface ToolPermissionManager {
  check(input: PermissionCheckInput): Promise<PermissionDecision>;
}

export interface ToolContext {
  repoPath: string;
  sessionId?: string;
  maxOutputChars?: number;
  sessionStore?: ToolSessionRecorder;
  eventStore?: ToolEventRecorder;
  permissionManager?: ToolPermissionManager;
  nonInteractive?: boolean;
  autoApprove?: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolResult<TData = unknown> {
  success: boolean;
  data?: TData;
  error?: ToolError;
  metadata?: Record<string, unknown>;
}

export type ToolSource = "local" | "mcp";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolMetadata {
  source?: ToolSource;
  category?: "filesystem" | "search" | "git" | "patch" | "command" | "web" | "external";
  annotations?: Partial<ToolAnnotations>;
}

export interface Tool<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  permissionLevel: PermissionLevel;
  metadata?: ToolMetadata;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TResult>>;
}

export function toolSuccess<TData>(
  data: TData,
  metadata?: Record<string, unknown>,
): ToolResult<TData> {
  return metadata ? { success: true, data, metadata } : { success: true, data };
}

export function toolFailure(
  code: string,
  message: string,
  details?: unknown,
  metadata?: Record<string, unknown>,
): ToolResult<never> {
  return {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details },
    ...(metadata ? { metadata } : {}),
  };
}
