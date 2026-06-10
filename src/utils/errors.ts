export class MiniAgentError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MiniAgentError";
    this.code = code;
    this.details = details;
  }
}

export class PathOutsideRepositoryError extends MiniAgentError {
  constructor(targetPath: string) {
    super("PATH_OUTSIDE_REPOSITORY", "Path is outside repository", { path: targetPath });
    this.name = "PathOutsideRepositoryError";
  }
}

export class ToolInputError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("INVALID_TOOL_INPUT", message, details);
    this.name = "ToolInputError";
  }
}

export class EmptyCommandError extends MiniAgentError {
  constructor() {
    super("EMPTY_COMMAND", "Command cannot be empty");
    this.name = "EmptyCommandError";
  }
}

export class CommandBlockedError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("COMMAND_BLOCKED", message, details);
    this.name = "CommandBlockedError";
  }
}

export class CommandPermissionDeniedError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("COMMAND_PERMISSION_DENIED", message, details);
    this.name = "CommandPermissionDeniedError";
  }
}

export class InvalidWorkingDirectoryError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("INVALID_WORKING_DIRECTORY", message, details);
    this.name = "InvalidWorkingDirectoryError";
  }
}

export class EmptyPatchError extends MiniAgentError {
  constructor() {
    super("EMPTY_PATCH", "Patch cannot be empty");
    this.name = "EmptyPatchError";
  }
}

export class PatchTooLargeError extends MiniAgentError {
  constructor(maxPatchChars: number) {
    super("PATCH_TOO_LARGE", `Patch exceeds maximum size of ${maxPatchChars} characters`, { maxPatchChars });
    this.name = "PatchTooLargeError";
  }
}

export class PatchCheckFailedError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("PATCH_CHECK_FAILED", message, details);
    this.name = "PatchCheckFailedError";
  }
}

export class PatchApplyFailedError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("PATCH_APPLY_FAILED", message, details);
    this.name = "PatchApplyFailedError";
  }
}

export class PatchPathOutsideRepoError extends MiniAgentError {
  constructor(targetPath: string) {
    super("PATCH_PATH_OUTSIDE_REPOSITORY", "Patch path is outside repository", { path: targetPath });
    this.name = "PatchPathOutsideRepoError";
  }
}

export class PatchTouchesInternalDirectoryError extends MiniAgentError {
  constructor(targetPath: string) {
    super("PATCH_TOUCHES_INTERNAL_DIRECTORY", "Patch cannot modify internal repository directories", { path: targetPath });
    this.name = "PatchTouchesInternalDirectoryError";
  }
}

export class PatchPermissionDeniedError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("PATCH_PERMISSION_DENIED", message, details);
    this.name = "PatchPermissionDeniedError";
  }
}

export class InvalidPatchFormatError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("INVALID_PATCH_FORMAT", message, details);
    this.name = "InvalidPatchFormatError";
  }
}

export class InvalidAgentDecisionError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("INVALID_AGENT_DECISION", message, details);
    this.name = "InvalidAgentDecisionError";
  }
}

export class LlmConfigurationError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("LLM_CONFIGURATION_ERROR", message, details);
    this.name = "LlmConfigurationError";
  }
}

export class LlmRequestError extends MiniAgentError {
  constructor(message: string, details?: unknown) {
    super("LLM_REQUEST_ERROR", message, details);
    this.name = "LlmRequestError";
  }
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function errorToCode(error: unknown, fallbackCode: string): string {
  if (error instanceof MiniAgentError) {
    return error.code;
  }

  return fallbackCode;
}

export function errorToDetails(error: unknown): unknown {
  if (error instanceof MiniAgentError) {
    return error.details;
  }

  return undefined;
}
