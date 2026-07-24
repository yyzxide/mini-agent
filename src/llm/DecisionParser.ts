import { z } from "zod";
import { AgentDecisionSchema } from "../agent/AgentDecision.js";
import type { AgentDecision } from "../agent/AgentDecision.js";
import { InvalidAgentDecisionError } from "../utils/errors.js";

export class DecisionParser {
  parse(rawText: string): AgentDecision {
    const jsonText = extractJsonText(rawText);
    const value = normalizeDecisionCandidate(parseJson(jsonText));
    assertRequiredDecisionFields(value);

    const parsed = AgentDecisionSchema.safeParse(value);
    if (!parsed.success) {
      throw new InvalidAgentDecisionError("AgentDecision schema validation failed", z.treeifyError(parsed.error));
    }

    return parsed.data;
  }
}

function normalizeDecisionCandidate(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }

  const rawType = readString(value.type);
  if (!rawType) {
    return value;
  }

  const type = rawType.trim().toUpperCase();
  switch (type) {
    case "PLAN":
      return {
        type,
        message: readString(value.message) ?? readString(value.summary) ?? readString(value.description),
      };
    case "TOOL_CALL":
      return {
        type,
        toolName: readString(value.toolName) ?? readString(value.name) ?? readString(value.tool),
        input: isObject(value.input) ? value.input : {},
        ...(readString(value.reason) ?? readString(value.rationale)
          ? { reason: readString(value.reason) ?? readString(value.rationale) }
          : {}),
      };
    case "DELEGATE":
    case "DELEGATE_READONLY":
      return {
        type,
        reason: readString(value.reason) ?? readString(value.message) ?? readString(value.description),
        tasks: Array.isArray(value.tasks) ? value.tasks : [],
      };
    case "APPLY_DELEGATED_PATCH":
      return {
        type,
        taskId: readString(value.taskId),
        description: readString(value.description)
          ?? readString(value.message)
          ?? "Apply delegated patch",
      };
    case "APPLY_PATCH":
      return {
        type,
        patch: readRawString(value.patch) ?? readRawString(value.diff),
        description: readString(value.description)
          ?? readString(value.message)
          ?? readString(value.summary)
          ?? "Apply repository patch",
      };
    case "RUN_COMMAND": {
      const command = readString(value.command);
      const shell = typeof value.shell === "boolean" ? value.shell : Boolean(command && !readString(value.executable));
      return {
        type,
        executable: readString(value.executable),
        args: Array.isArray(value.args) ? value.args : [],
        command,
        shell,
        cwd: readString(value.cwd),
        timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : undefined,
        description: readString(value.description)
          ?? readString(value.message)
          ?? (command ? `Run ${command}` : "Run command"),
      };
    }
    case "ASK_USER":
      return {
        type,
        message: readString(value.message) ?? readString(value.question) ?? readString(value.summary),
      };
    case "FINAL":
      return {
        type,
        summary: readString(value.summary) ?? readString(value.message) ?? readString(value.answer),
        success: typeof value.success === "boolean" ? value.success : true,
      };
    case "FAILED":
      return {
        type,
        error: readString(value.error) ?? readString(value.message) ?? readString(value.summary),
      };
    default:
      return { ...value, type };
  }
}

export function parseAgentDecision(rawText: string): AgentDecision {
  return new DecisionParser().parse(rawText);
}

function extractJsonText(rawText: string): string {
  const text = rawText.trim();
  if (text.length === 0) {
    throw new InvalidAgentDecisionError("LLM response is empty");
  }

  const codeBlockJson = extractJsonFromCodeBlocks(text);
  if (codeBlockJson) {
    return codeBlockJson;
  }

  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  const objectText = extractFirstJsonObject(removeNonJsonCodeBlocks(text));
  if (objectText) {
    return objectText;
  }

  throw new InvalidAgentDecisionError("LLM response did not contain a JSON object");
}

function extractJsonFromCodeBlocks(text: string): string | undefined {
  const codeBlockPattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockPattern.exec(text)) !== null) {
    const language = (match[1] ?? "").trim().toLowerCase();
    const content = (match[2] ?? "").trim();
    if (!content) {
      continue;
    }

    if (language === "json" || (!language && content.startsWith("{"))) {
      return content;
    }
  }

  return undefined;
}

function removeNonJsonCodeBlocks(text: string): string {
  return text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (block, language: string, content: string) => {
    const normalizedLanguage = language.trim().toLowerCase();
    const normalizedContent = content.trim();
    if (normalizedLanguage === "json" || (!normalizedLanguage && normalizedContent.startsWith("{"))) {
      return block;
    }

    return "";
  });
}

function parseJson(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidAgentDecisionError(`Invalid JSON in LLM response: ${message}`);
  }
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function assertRequiredDecisionFields(value: unknown): void {
  if (!isObject(value)) {
    throw new InvalidAgentDecisionError("AgentDecision must be a JSON object");
  }

  if (typeof value.type !== "string") {
    throw new InvalidAgentDecisionError("AgentDecision is missing type");
  }

  switch (value.type) {
    case "PLAN":
    case "ASK_USER":
    case "FINAL":
    case "FAILED":
      return;
    case "TOOL_CALL":
      if (typeof value.toolName !== "string" || value.toolName.trim().length === 0) {
        throw new InvalidAgentDecisionError("TOOL_CALL decision is missing toolName");
      }
      return;
    case "DELEGATE":
    case "DELEGATE_READONLY":
    case "APPLY_DELEGATED_PATCH":
      return;
    case "APPLY_PATCH":
      if (typeof value.patch !== "string" || value.patch.trim().length === 0) {
        throw new InvalidAgentDecisionError("APPLY_PATCH decision is missing patch");
      }
      return;
    case "RUN_COMMAND":
      if (value.shell === true) {
        if (typeof value.command !== "string" || value.command.trim().length === 0) {
          throw new InvalidAgentDecisionError("RUN_COMMAND shell decision is missing command");
        }
        return;
      }

      if (typeof value.executable !== "string" || value.executable.trim().length === 0) {
        throw new InvalidAgentDecisionError("RUN_COMMAND decision is missing executable");
      }
      return;
    default:
      throw new InvalidAgentDecisionError(`Unknown AgentDecision type: ${value.type}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRawString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
