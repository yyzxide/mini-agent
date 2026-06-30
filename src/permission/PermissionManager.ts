import { createInterface } from "node:readline/promises";
import process from "node:process";
import { PermissionLevel } from "./PermissionLevel.js";

export interface PermissionCheckInput {
  level: PermissionLevel;
  action: string;
  description?: string;
  command?: string;
  targetPath?: string;
  nonInteractive?: boolean;
  autoApprove?: boolean;
  requiresExplicitApproval?: boolean;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
  mode: "AUTO" | "USER_APPROVED" | "USER_REJECTED" | "BLOCKED";
}

export type PermissionPrompt = (message: string) => Promise<string>;

export interface PermissionManagerOptions {
  prompt?: PermissionPrompt;
}

interface BlockRule {
  name: string;
  pattern: RegExp;
}

const BLOCK_RULES: BlockRule[] = [
  { name: "rm -rf /", pattern: /\brm\s+-rf\s+\/(?:\s|$)/ },
  { name: "rm -rf /*", pattern: /\brm\s+-rf\s+\/\*(?:\s|$)/ },
  { name: "sudo", pattern: /(^|[;&|]\s*)sudo(?:\s|$)/ },
  { name: "mkfs", pattern: /(^|[;&|]\s*)mkfs(?:[.\w-]*)(?:\s|$)/ },
  { name: "shutdown", pattern: /(^|[;&|]\s*)shutdown(?:\s|$)/ },
  { name: "reboot", pattern: /(^|[;&|]\s*)reboot(?:\s|$)/ },
  { name: "chmod 777 /", pattern: /\bchmod\s+777\s+\/(?:\s|$)/ },
  { name: "chown -R", pattern: /\bchown\s+-r(?:\s|$)/ },
  { name: "dd if=", pattern: /(^|[;&|]\s*)dd\s+[^;&|]*\bif=/ },
];

export class PermissionManager {
  private readonly prompt: PermissionPrompt | undefined;

  constructor(options: PermissionManagerOptions = {}) {
    this.prompt = options.prompt;
  }

  async check(input: PermissionCheckInput): Promise<PermissionDecision> {
    if (input.command) {
      const blocked = findBlockedCommand(input.command);
      if (blocked) {
        return {
          allowed: false,
          mode: "BLOCKED",
          reason: `Blocked dangerous command pattern: ${blocked}`,
        };
      }
    }

    if (input.level === PermissionLevel.SAFE) {
      return { allowed: true, mode: "AUTO", reason: "SAFE action is allowed automatically" };
    }

    if (input.autoApprove && !input.requiresExplicitApproval) {
      return { allowed: true, mode: "AUTO", reason: "Auto-approved by caller" };
    }

    if (input.nonInteractive) {
      return {
        allowed: false,
        mode: "USER_REJECTED",
        reason: input.requiresExplicitApproval
          ? `${input.level} action requires explicit approval; non-interactive mode cannot prompt`
          : `${input.level} action requires approval; non-interactive mode cannot prompt`,
      };
    }

    const answer = (await this.askUser(input)).trim().toLowerCase();
    if (answer === "yes" || answer === "y") {
      return { allowed: true, mode: "USER_APPROVED", reason: "Approved by user" };
    }

    return { allowed: false, mode: "USER_REJECTED", reason: "Rejected by user" };
  }

  private async askUser(input: PermissionCheckInput): Promise<string> {
    const message = buildPromptMessage(input);
    if (this.prompt) {
      return await this.prompt(message);
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }
}

export function findBlockedCommand(command: string): string | undefined {
  const normalized = command.trim().toLowerCase();
  const compact = normalized.replace(/\s+/g, "");

  if (compact.includes(":(){:|:&};:")) {
    return ":(){ :|:& };:";
  }

  return BLOCK_RULES.find((rule) => rule.pattern.test(normalized))?.name;
}

function buildPromptMessage(input: PermissionCheckInput): string {
  if (input.command) {
    return [
      input.requiresExplicitApproval
        ? "Agent wants to run a high-risk shell command:"
        : "Agent wants to run command:",
      "",
      input.command,
      "",
      "Allow?",
      "1. yes",
      "2. no",
      "> ",
    ].join("\n");
  }

  return [
    `Agent requests ${input.level} permission for ${input.action}.`,
    input.description ? input.description : undefined,
    input.targetPath ? `Target: ${input.targetPath}` : undefined,
    "",
    "Allow?",
    "1. yes",
    "2. no",
    "> ",
  ].filter((line) => line !== undefined).join("\n");
}
