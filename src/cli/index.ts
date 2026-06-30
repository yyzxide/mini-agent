#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { execa } from "execa";
import { AgentLoop } from "../agent/AgentLoop.js";
import type { AgentProgressEvent } from "../agent/AgentLoop.js";
import { routeTask } from "../agent/TaskRouter.js";
import { CommandRunner } from "../command/CommandRunner.js";
import type { CommandResult } from "../command/CommandRunner.js";
import {
  initAgentConfig,
  loadAgentConfig,
  redactAgentConfig,
  resolveLlmConfig,
} from "../config/AgentConfig.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { MessageCompressor } from "../context/MessageCompressor.js";
import { formatRepoState, RepoStateAnalyzer } from "../context/RepoStateAnalyzer.js";
import { formatRuntimeContext } from "../context/RuntimeContext.js";
import { GitManager } from "../git/GitManager.js";
import { OpenAICompatibleClient } from "../llm/OpenAICompatibleClient.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import { SessionStore } from "../session/SessionStore.js";
import { TaskChangeLogStore } from "../session/TaskChangeLogStore.js";
import type { TaskChangeLogEntry, TaskChangeMode, TaskChangeTestResult } from "../session/TaskChangeLogStore.js";
import type { EventRecord, JsonObject, SessionMeta, SessionRecord } from "../session/SessionTypes.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext, ToolResult } from "../tools/Tool.js";
import {
  CommandBlockedError,
  CommandPermissionDeniedError,
  errorToCode,
  errorToDetails,
  errorToMessage,
} from "../utils/errors.js";
import { resolveRepoPath } from "../utils/fs.js";
import { toJsonObject } from "../utils/json.js";
import { createRuntimeLogger, readRuntimeLogs } from "../utils/logger.js";
import type { LogLevel, LogRecord } from "../utils/logger.js";
import type { WebQuestionPlan } from "../web/WebQuestionPlanner.js";
import { planWebQuestion } from "../web/WebQuestionPlanner.js";

const VERSION = "0.1.0";
const INTERACTIVE_RESUME_LIST_LIMIT = 10;

interface AgentCliOptions {
  session?: string;
  maxSteps?: number;
  model?: string;
  baseUrl?: string;
  eventStream?: boolean;
  agentLoop?: boolean;
  keepSessionActive?: boolean;
}

interface CliTaskResult {
  success: boolean;
  sessionId?: string;
  mode: TaskChangeMode;
  summary: string;
  error?: string;
}

interface GitSnapshot {
  changedFiles: string[];
  diffStat: string | null;
}

interface ConfigInitOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("mini-agent")
    .description("Local conversational AI coding agent CLI")
    .version(VERSION)
    .action(async () => {
      await startInteractive(process.cwd());
    });

  program
    .command("run")
    .description("Run a single coding task")
    .argument("<task...>", "Natural language coding task")
    .option("--session <sessionId>", "Session id used for the task")
    .option("--max-steps <number>", "Maximum agent loop steps", parsePositiveInteger)
    .option("--model <model>", "Override MINI_AGENT_MODEL for OpenAI-compatible clients")
    .option("--base-url <url>", "Override MINI_AGENT_BASE_URL for OpenAI-compatible clients")
    .option("--event-stream", "Print structured MINI_AGENT_EVENT lines for local integrations")
    .option("--agent-loop", "Force the repository-editing agent loop even for direct-answer tasks")
    .action(async (taskParts: string[], options: AgentCliOptions) => {
      const task = taskParts.join(" ").trim();
      if (task.length === 0) {
        throw new Error("Task cannot be empty.");
      }

      const result = await runAgentTask(process.cwd(), task, options);

      if (!result.success) {
        process.exitCode = 1;
      }
    });

  const configCommand = program
    .command("config")
    .description("Manage local mini-agent configuration");

  configCommand
    .command("init")
    .description("Create or update mini-agent.config.json")
    .option("--base-url <url>", "OpenAI-compatible base URL")
    .option("--api-key <key>", "OpenAI-compatible API key stored in mini-agent.config.json")
    .option("--api-key-env <name>", "Environment variable name that stores the API key")
    .option("--model <model>", "OpenAI-compatible model name")
    .option("--temperature <number>", "Model temperature", parseNumber)
    .option("--max-tokens <number>", "Maximum output tokens", parsePositiveInteger)
    .option("--timeout-ms <number>", "LLM request timeout in milliseconds", parsePositiveInteger)
    .action(async (options: ConfigInitOptions) => {
      await runJsonAction(async () => {
        const config = await initAgentConfig(process.cwd(), {
          llm: {
            mode: "real",
            baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          },
        });

        writeJson(redactAgentConfig(config));
      });
    });

  configCommand
    .command("show")
    .description("Show mini-agent.config.json with secrets redacted")
    .option("--raw", "Print raw config including secrets")
    .action(async (options: { raw?: boolean }) => {
      await runJsonAction(async () => {
        const config = await loadAgentConfig(process.cwd());
        writeJson(options.raw ? config : redactAgentConfig(config));
      });
    });

  program
    .command("resume")
    .description("Resume a previous session")
    .argument("<sessionId>", "Session id to resume")
    .action(async (sessionId: string) => {
      await startInteractive(process.cwd(), sessionId);
    });

  program
    .command("sessions")
    .description("List local sessions")
    .action(async () => {
      await runJsonAction(async () => {
        const { sessionStore } = createStores(process.cwd());
        const sessions = await sessionStore.listSessions();
        writeJson(sessions);
      });
    });

  const sessionCommand = program
    .command("session")
    .description("Manage local sessions");

  sessionCommand
    .command("create")
    .description("Create a local session")
    .option("--title <title>", "Session title", "Untitled session")
    .action(async (options: { title: string }) => {
      await runJsonAction(async () => {
        const { sessionStore, eventStore } = createStores(process.cwd());
        const created = await sessionStore.createSession({ title: options.title });
        await eventStore.appendEvent(created.sessionId, {
          type: "SESSION_CREATED",
          payload: {
            title: created.title,
            repoPath: created.repoPath,
            baseCommit: created.baseCommit,
          },
        });
        writeJson(await sessionStore.getSessionMeta(created.sessionId));
      });
    });

  sessionCommand
    .command("show")
    .description("Show session records")
    .argument("<sessionId>", "Session id")
    .action(async (sessionId: string) => {
      await runJsonAction(async () => {
        const { sessionStore } = createStores(process.cwd());
        writeJson(await sessionStore.readRecords(sessionId));
      });
    });

  sessionCommand
    .command("events")
    .description("Show session events")
    .argument("<sessionId>", "Session id")
    .action(async (sessionId: string) => {
      await runJsonAction(async () => {
        const { eventStore } = createStores(process.cwd());
        writeJson(await eventStore.readEvents(sessionId));
      });
    });

  program
    .command("diff")
    .description("Print git diff for the current repository")
    .action(async () => {
      const diff = await readGitDiff(process.cwd());
      process.stdout.write(diff.length > 0 ? diff : "[diff] No changes.\n");
    });

  program
    .command("status")
    .description("Print an intelligent repository state summary")
    .action(async () => {
      process.stdout.write(`${await readRepoState(process.cwd())}\n`);
    });

  program
    .command("doctor")
    .description("Print environment and configuration diagnostics")
    .action(async () => {
      await runJsonAction(async () => {
        writeJson(await buildDoctorReport(process.cwd()));
      });
    });

  program
    .command("logs")
    .description("Show recent runtime logs")
    .option("--limit <number>", "Maximum records to print", parsePositiveInteger, 50)
    .option("--level <level>", "Filter by level: debug, info, warn, error", parseLogLevel)
    .action(async (options: { limit: number; level?: LogLevel }) => {
      await runJsonAction(async () => {
        writeJson(await readRuntimeLogs(process.cwd(), {
          limit: options.limit,
          ...(options.level ? { level: options.level } : {}),
        }));
      });
    });

  program
    .command("changes")
    .description("Show recent task change-log entries")
    .option("--limit <number>", "Maximum records to print", parsePositiveInteger, 50)
    .action(async (options: { limit: number }) => {
      await runJsonAction(async () => {
        writeJson(await new TaskChangeLogStore({ repoPath: process.cwd() }).list(options.limit));
      });
    });

  const gitCommand = program
    .command("git")
    .description("Run git workflow debug commands");

  gitCommand
    .command("status")
    .description("Show git status")
    .action(async () => {
      await runJsonAction(async () => {
        const git = new GitManager({ repoPath: process.cwd() });
        writeJson({
          branch: await git.getCurrentBranch(),
          commit: await git.getCurrentCommit(),
          status: await git.getStatus(),
          changedFiles: await git.getChangedFiles(),
        });
      });
    });

  gitCommand
    .command("diff")
    .description("Show git diff")
    .action(async () => {
      await runJsonAction(async () => {
        const git = new GitManager({ repoPath: process.cwd() });
        writeJson(await git.getDiff());
      });
    });

  const gitBranchCommand = gitCommand
    .command("branch")
    .description("Run git branch debug commands");

  gitBranchCommand
    .command("create")
    .description("Create and checkout a git branch")
    .argument("<branchName>", "Branch name")
    .action(async (branchName: string) => {
      await runJsonAction(async () => {
        const git = new GitManager({ repoPath: process.cwd() });
        const baseBranch = await git.getCurrentBranch();
        const baseCommit = await git.getCurrentCommit();
        await git.createBranch(branchName);
        await git.checkoutBranch(branchName);
        writeJson({
          baseBranch,
          baseCommit,
          workBranch: await git.getCurrentBranch(),
        });
      });
    });

  gitCommand
    .command("commit")
    .description("Commit current changes")
    .requiredOption("--message <message>", "Commit message")
    .action(async (options: { message: string }) => {
      await runJsonAction(async () => {
        const git = new GitManager({ repoPath: process.cwd() });
        writeJson(await git.commit(options.message));
      });
    });

  const commandCommand = program
    .command("command")
    .description("Run command-system debug commands");

  commandCommand
    .command("run")
    .description("Run a shell command with permission checks")
    .argument("<command>", "Shell command to run")
    .option("--session <sessionId>", "Session id used for event and record logging")
    .option("--timeout <ms>", "Command timeout in milliseconds", parsePositiveInteger)
    .option("--cwd <path>", "Working directory relative to the repository root")
    .action(async (command: string, options: {
      session?: string;
      timeout?: number;
      cwd?: string;
    }) => {
      await runJsonAction(async () => {
        const repoPath = process.cwd();
        const logger = createRuntimeLogger(repoPath);
        await logger.info("command", "Command requested", {
          command,
          timeoutMs: options.timeout ?? null,
          cwd: options.cwd ?? ".",
        }, options.session).catch(() => undefined);
        const permissionManager = new PermissionManager();
        const permission = await permissionManager.check({
          level: PermissionLevel.DANGEROUS,
          action: "run_shell_command",
          description: "Run a shell command from the local repository.",
          command,
          autoApprove: true,
          nonInteractive: true,
        });

        if (!permission.allowed) {
          const error = permission.mode === "BLOCKED"
            ? new CommandBlockedError(permission.reason ?? "Command was blocked", { permission })
            : new CommandPermissionDeniedError(permission.reason ?? "Command permission denied", { permission });
          writeJsonError(error);
          process.exitCode = 1;
          return;
        }

        const stores = options.session ? createStores(repoPath) : undefined;
        if (stores && options.session) {
          await stores.sessionStore.ensureSession(options.session);
          await stores.eventStore.init();
        }

        const runner = new CommandRunner({ repoPath });
        const cwd = await runner.resolveCwd(options.cwd);
        const timeoutMs = options.timeout ?? runner.defaultTimeoutMs;

        if (stores && options.session) {
          await stores.eventStore.appendEvent(options.session, {
            type: "COMMAND_STARTED",
            payload: {
              command,
              cwd,
              timeoutMs,
            },
          });
        }

        const result = await runner.run({
          command,
          shell: true,
          cwd,
          timeoutMs,
        });

        await logger[result.success ? "info" : "error"]("command", "Command finished", {
          command: result.command,
          exitCode: result.exitCode,
          success: result.success,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        }, options.session).catch(() => undefined);

        if (stores && options.session) {
          await stores.sessionStore.appendRecord(options.session, {
            type: "COMMAND_RESULT",
            payload: commandResultToPayload(result),
          });
          await stores.eventStore.appendEvent(options.session, {
            type: "COMMAND_FINISHED",
            payload: {
              command: result.command,
              exitCode: result.exitCode,
              success: result.success,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
              truncated: result.truncated,
            },
          });

          if (isTestCommand(result.command)) {
            await stores.eventStore.appendEvent(options.session, {
              type: result.success ? "TEST_PASSED" : "TEST_FAILED",
              payload: {
                command: result.command,
                exitCode: result.exitCode,
                stderrPreview: result.stderr.slice(0, 1000),
              },
            });
          }
        }

        writeJson(result);
      });
    });

  const patchCommand = program
    .command("patch")
    .description("Preview and apply unified diff patches");

  patchCommand
    .command("preview")
    .description("Preview a unified diff patch")
    .argument("[patchFile]", "Patch file path relative to the repository root")
    .action(async (patchFile?: string) => {
      await runJsonAction(async () => {
        const patch = await readPatchInput(process.cwd(), patchFile);
        const patchManager = new PatchManager({ repoPath: process.cwd() });
        writeJson(await patchManager.previewPatch({ patch }));
      });
    });

  patchCommand
    .command("apply")
    .description("Apply a unified diff patch")
    .argument("[patchFile]", "Patch file path relative to the repository root")
    .option("--session <sessionId>", "Session id used for event and record logging")
    .action(async (patchFile: string | undefined, options: { session?: string }) => {
      await runJsonAction(async () => {
        const repoPath = process.cwd();
        const logger = createRuntimeLogger(repoPath);
        const patch = await readPatchInput(repoPath, patchFile);
        const registry = createDefaultToolRegistry();
        const stores = options.session ? createStores(repoPath) : undefined;

        if (stores && options.session) {
          await stores.sessionStore.ensureSession(options.session);
          await stores.eventStore.init();
        }

        const context: ToolContext = {
          repoPath,
          permissionManager: new PermissionManager(),
          autoApprove: true,
          nonInteractive: true,
        };

        if (stores && options.session) {
          context.sessionId = options.session;
          context.sessionStore = stores.sessionStore;
          context.eventStore = stores.eventStore;
        }

        await logger.info("patch", "Patch apply requested", {
          patchFile: patchFile ?? "(stdin)",
          patchChars: patch.length,
        }, options.session).catch(() => undefined);

        const result = await registry.execute("apply_patch", { patch, checkBeforeApply: true }, context);
        await logger[result.success ? "info" : "error"]("patch", "Patch apply finished", {
          success: result.success,
          error: result.error ?? null,
          metadata: result.metadata ?? null,
        }, options.session).catch(() => undefined);
        writeJson(result);
      });
    });

  const toolCommand = program
    .command("tool")
    .description("Run tool-system debug commands");

  toolCommand
    .command("list")
    .description("List registered tools")
    .action(() => {
      const registry = createDefaultToolRegistry();
      writeJson(registry.list());
    });

  toolCommand
    .command("run")
    .description("Run a registered tool with JSON input")
    .argument("<name>", "Tool name")
    .argument("[jsonInput]", "Tool input as JSON", "{}")
    .option("--session <sessionId>", "Session id used for event and record logging")
    .action(async (name: string, jsonInput: string, options: { session?: string }) => {
      const parsedInput = parseJsonInput(jsonInput);

      if (!parsedInput.success) {
        writeJson(parsedInput);
        process.exitCode = 1;
        return;
      }

      await runJsonAction(async () => {
        const registry = createDefaultToolRegistry();
        const stores = options.session ? createStores(process.cwd()) : undefined;
        const logger = createRuntimeLogger(process.cwd());

        if (stores && options.session) {
          await stores.sessionStore.ensureSession(options.session);
          await stores.eventStore.init();
        }

        const toolContext: ToolContext = {
          repoPath: process.cwd(),
          permissionManager: new PermissionManager(),
          autoApprove: true,
          nonInteractive: true,
        };

        if (options.session && stores) {
          toolContext.sessionId = options.session;
          toolContext.sessionStore = stores.sessionStore;
          toolContext.eventStore = stores.eventStore;
        }

        await logger.info("tool", "Tool requested", {
          toolName: name,
          input: parsedInput.data,
        }, options.session).catch(() => undefined);

        const result = await registry.execute(name, parsedInput.data, toolContext);
        await logger[result.success ? "info" : "error"]("tool", "Tool finished", {
          toolName: name,
          success: result.success,
          error: result.error ?? null,
        }, options.session).catch(() => undefined);

        writeJson(result);
      });
    });

  return program;
}

async function startInteractive(repoPath: string, resumeSessionId?: string): Promise<void> {
  const stores = createStores(repoPath);
  let currentSessionId = resumeSessionId
    ? await ensureInteractiveSession(stores.sessionStore, stores.eventStore, resumeSessionId)
    : await createInteractiveSession(stores.sessionStore, stores.eventStore, "Interactive session");

  process.stdout.write("Mini Coding Agent\n");
  process.stdout.write(`Current repo: ${repoPath}\n`);
  process.stdout.write(`Current session: ${currentSessionId}\n`);
  process.stdout.write("Type your coding task, or use /help, /exit, /new, /resume, /diff, /status, /sessions.\n\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await rl.question("> ")).trim();

      if (answer.length === 0) {
        continue;
      }

      if (answer.startsWith("/")) {
        const slashResult = await handleInteractiveSlashCommand({
          command: answer,
          repoPath,
          stores,
          currentSessionId,
          prompt: async (message) => await rl.question(message),
        });

        currentSessionId = slashResult.sessionId;
        if (slashResult.exit) {
          return;
        }
        continue;
      }

      await runAgentTask(repoPath, answer, {
        session: currentSessionId,
        nonInteractive: false,
        keepSessionActive: true,
      }, async (message) => await rl.question(message));
    }
  } finally {
    rl.close();
  }
}

async function handleInteractiveSlashCommand(input: {
  command: string;
  repoPath: string;
  stores: { sessionStore: SessionStore; eventStore: EventStore };
  currentSessionId: string;
  prompt?: (message: string) => Promise<string>;
}): Promise<{ sessionId: string; exit: boolean }> {
  const [name = "", ...args] = input.command.trim().split(/\s+/);
  const logger = createRuntimeLogger(input.repoPath);

  switch (name) {
    case "/help":
      printInteractiveHelp();
      return { sessionId: input.currentSessionId, exit: false };

    case "/exit":
      await input.stores.sessionStore.updateSessionStatus(input.currentSessionId, "FINISHED");
      await logger.info("cli", "Interactive session exited", {}, input.currentSessionId).catch(() => undefined);
      process.stdout.write("Bye.\n");
      return { sessionId: input.currentSessionId, exit: true };

    case "/new": {
      const sessionId = await createInteractiveSession(input.stores.sessionStore, input.stores.eventStore, "Interactive session");
      await logger.info("cli", "Interactive session created", {}, sessionId).catch(() => undefined);
      process.stdout.write(`[session] ${sessionId}\n`);
      return { sessionId, exit: false };
    }

    case "/resume": {
      let selector = args[0];
      if (!selector) {
        await printInteractiveResumeList(input.stores.sessionStore);
        if (!input.prompt) {
          return { sessionId: input.currentSessionId, exit: false };
        }

        selector = (await input.prompt("resume> ")).trim();
        if (!selector) {
          process.stdout.write("[resume] Canceled.\n");
          return { sessionId: input.currentSessionId, exit: false };
        }
      }

      const sessionId = await resolveInteractiveResumeSelector(input.stores.sessionStore, selector);
      if (!sessionId) {
        process.stdout.write(`[resume] No recent session matches "${selector}". Use /resume to list recent sessions.\n`);
        return { sessionId: input.currentSessionId, exit: false };
      }

      const resumedSessionId = await ensureInteractiveSession(input.stores.sessionStore, input.stores.eventStore, sessionId);
      await input.stores.eventStore.appendEvent(resumedSessionId, {
        type: "SESSION_RESUMED",
        payload: {
          mode: "interactive",
        },
      });
      await logger.info("cli", "Interactive session resumed", {}, resumedSessionId).catch(() => undefined);
      process.stdout.write(`[session] ${resumedSessionId}\n`);
      return { sessionId: resumedSessionId, exit: false };
    }

    case "/session": {
      const meta = await input.stores.sessionStore.getSessionMeta(input.currentSessionId);
      process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/diff": {
      const diff = await readGitDiff(input.repoPath);
      process.stdout.write(diff.length > 0 ? diff : "[diff] No changes.\n");
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/status":
      process.stdout.write(`${await readRepoState(input.repoPath)}\n`);
      return { sessionId: input.currentSessionId, exit: false };

    case "/sessions":
      await printInteractiveSessions(input.stores.sessionStore);
      return { sessionId: input.currentSessionId, exit: false };

    case "/history":
      await printInteractiveHistory(input.stores.sessionStore, input.currentSessionId, parseOptionalLimit(args[0], 20));
      return { sessionId: input.currentSessionId, exit: false };

    case "/events":
      await printInteractiveEvents(input.stores.eventStore, input.currentSessionId, parseOptionalLimit(args[0], 30));
      return { sessionId: input.currentSessionId, exit: false };

    case "/logs":
      await printInteractiveLogs(input.repoPath, parseOptionalLimit(args[0], 20));
      return { sessionId: input.currentSessionId, exit: false };

    case "/changes":
      await printInteractiveChanges(input.repoPath, parseOptionalLimit(args[0], 20));
      return { sessionId: input.currentSessionId, exit: false };

    case "/compact":
      await compactInteractiveSession(input.stores.sessionStore, input.stores.eventStore, input.currentSessionId);
      return { sessionId: input.currentSessionId, exit: false };

    case "/clear":
      console.clear();
      return { sessionId: input.currentSessionId, exit: false };

    default:
      process.stdout.write(`[unknown] ${name}. Use /help to list commands.\n`);
      return { sessionId: input.currentSessionId, exit: false };
  }
}

function printInteractiveHelp(): void {
  process.stdout.write([
    "Slash commands:",
    "  /help              Show this help.",
    "  /new               Start a new conversation session.",
    "  /resume [n|id]     Pick from recent sessions, or switch by number/id.",
    "  /session           Show current session metadata.",
    "  /sessions          List local sessions.",
    "  /history [n]       Show recent session records.",
    "  /events [n]        Show recent session events.",
    "  /logs [n]          Show recent runtime logs.",
    "  /changes [n]       Show recent task change-log entries.",
    "  /compact           Write a compact memory record for this session.",
    "  /status            Show repository state summary.",
    "  /diff              Show git diff.",
    "  /clear             Clear the terminal.",
    "  /exit              Finish this session and exit.",
    "",
  ].join("\n"));
}

async function printInteractiveResumeList(sessionStore: SessionStore): Promise<void> {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    process.stdout.write("[resume] No sessions yet.\n");
    return;
  }

  const recentSessions = sessions.slice(0, INTERACTIVE_RESUME_LIST_LIMIT);
  const sessionRows = await Promise.all(recentSessions.map(async (session) => ({
    session,
    lastUserMessage: await readLastUserMessage(sessionStore, session.sessionId),
  })));

  process.stdout.write(`[resume] Recent sessions (${recentSessions.length} of ${sessions.length}):\n`);
  for (const [index, row] of sessionRows.entries()) {
    process.stdout.write(`${formatResumeSessionLine(index + 1, row.session, row.lastUserMessage)}\n`);
  }

  process.stdout.write("[resume] Enter a number/id to resume, or press Enter to cancel. Use /sessions for the full list.\n");
}

async function printInteractiveSessions(sessionStore: SessionStore): Promise<void> {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    process.stdout.write("[sessions] No sessions yet.\n");
    return;
  }

  for (const session of sessions) {
    process.stdout.write(`[session] ${session.sessionId} ${session.status} ${session.updatedAt} ${session.title}\n`);
  }
}

async function resolveInteractiveResumeSelector(
  sessionStore: SessionStore,
  selector: string,
): Promise<string | undefined> {
  if (!/^\d+$/.test(selector)) {
    return selector;
  }

  const index = Number.parseInt(selector, 10);
  if (!Number.isInteger(index) || index < 1 || index > INTERACTIVE_RESUME_LIST_LIMIT) {
    return undefined;
  }

  const sessions = await sessionStore.listSessions();
  return sessions[index - 1]?.sessionId;
}

async function readLastUserMessage(sessionStore: SessionStore, sessionId: string): Promise<string | undefined> {
  const records = await sessionStore.readRecords(sessionId).catch(() => []);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "USER_MESSAGE") {
      continue;
    }

    const content = readPayloadString(record.payload, "content");
    if (content) {
      return content;
    }
  }

  return undefined;
}

async function printInteractiveHistory(
  sessionStore: SessionStore,
  sessionId: string,
  limit: number,
): Promise<void> {
  const records = (await sessionStore.readRecords(sessionId)).slice(-limit);
  if (records.length === 0) {
    process.stdout.write("[history] No records.\n");
    return;
  }

  for (const record of records) {
    process.stdout.write(`${formatSessionRecord(record)}\n`);
  }
}

async function printInteractiveEvents(
  eventStore: EventStore,
  sessionId: string,
  limit: number,
): Promise<void> {
  const events = await eventStore.tailEvents(sessionId, limit);
  if (events.length === 0) {
    process.stdout.write("[events] No events.\n");
    return;
  }

  for (const event of events) {
    process.stdout.write(`${formatEventRecord(event)}\n`);
  }
}

async function printInteractiveLogs(repoPath: string, limit: number): Promise<void> {
  const records = await readRuntimeLogs(repoPath, { limit });
  if (records.length === 0) {
    process.stdout.write("[logs] No runtime logs.\n");
    return;
  }

  for (const record of records) {
    process.stdout.write(`${formatLogRecord(record)}\n`);
  }
}

async function printInteractiveChanges(repoPath: string, limit: number): Promise<void> {
  const changes = await new TaskChangeLogStore({ repoPath }).list(limit);
  if (changes.length === 0) {
    process.stdout.write("[changes] No task change-log entries.\n");
    return;
  }

  for (const change of changes) {
    process.stdout.write(`${formatTaskChangeLogEntry(change)}\n`);
  }
}

async function compactInteractiveSession(
  sessionStore: SessionStore,
  eventStore: EventStore,
  sessionId: string,
): Promise<void> {
  const memory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 20_000 });
  const summary = new MessageCompressor({ maxChars: 4_000 }).compress(memory);
  await sessionStore.appendRecord(sessionId, {
    type: "MEMORY_COMPACTION",
    payload: {
      summary,
      source: "local_transcript_compaction",
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "SESSION_COMPACTED",
    payload: {
      maxChars: 4_000,
      source: "local_transcript_compaction",
    },
  });
  process.stdout.write("[compact] Session memory compaction record written.\n");
}

async function ensureInteractiveSession(
  sessionStore: SessionStore,
  eventStore: EventStore,
  sessionId: string,
): Promise<string> {
  await sessionStore.ensureSession(sessionId);
  await eventStore.init();
  return sessionId;
}

async function createInteractiveSession(
  sessionStore: SessionStore,
  eventStore: EventStore,
  title: string,
): Promise<string> {
  const created = await sessionStore.createSession({ title });
  await eventStore.appendEvent(created.sessionId, {
    type: "SESSION_CREATED",
    payload: {
      title: created.title,
      repoPath: created.repoPath,
      baseCommit: created.baseCommit,
      mode: "interactive",
    },
  });

  return created.sessionId;
}

async function runAgentTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions & { nonInteractive?: boolean },
  prompt?: (message: string) => Promise<string>,
): Promise<CliTaskResult> {
  const route = routeTask(userGoal);
  const mode: TaskChangeMode = options.agentLoop === true ? "AGENT_LOOP" : route.intent;
  const logger = createRuntimeLogger(repoPath);
  const beforeSnapshot = await readGitSnapshot(repoPath);
  let taskResult: CliTaskResult;

  await logger.info("cli", "Task started", {
    task: userGoal,
    mode,
    reason: route.reason,
    requestedSessionId: options.session ?? null,
  }).catch(() => undefined);

  try {
    if (route.intent === "DIRECT_ANSWER" && options.agentLoop !== true) {
      taskResult = await runDirectAnswerTask(repoPath, userGoal, options);
    } else if (route.intent === "WEB_ANSWER" && options.agentLoop !== true) {
      taskResult = await runWebAnswerTask(repoPath, userGoal, options);
    } else {
      taskResult = await runAgentLoopTask(repoPath, userGoal, options, prompt);
    }
  } catch (error) {
    await logger.error("cli", "Task crashed", {
      task: userGoal,
      mode,
      error: errorToMessage(error),
      code: errorToCode(error, "TASK_CRASHED"),
      details: errorToDetails(error),
    }).catch(() => undefined);
    throw error;
  }

  if (taskResult.sessionId) {
    await appendTaskChangeLog(repoPath, {
      userGoal,
      result: taskResult,
      beforeSnapshot,
    }).catch(async (error: unknown) => {
      await logger.error("cli", "Failed to append task change log", {
        sessionId: taskResult.sessionId,
        task: userGoal,
        error: errorToMessage(error),
      }).catch(() => undefined);
    });
  }

  await logger[taskResult.success ? "info" : "error"]("cli", "Task finished", {
    task: userGoal,
    mode: taskResult.mode,
    summary: taskResult.summary,
    error: taskResult.error ?? null,
  }, taskResult.sessionId).catch(() => undefined);

  return taskResult;
}

async function runAgentLoopTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions & { nonInteractive?: boolean },
  prompt?: (message: string) => Promise<string>,
): Promise<CliTaskResult> {
  const { sessionStore, eventStore } = createStores(repoPath, options.eventStream === true);
  const permissionManager = new PermissionManager(prompt ? { prompt } : {});
  const llmClient = await createOpenAICompatibleClient(repoPath, options);
  const loop = new AgentLoop({
    repoPath,
    llmClient,
    toolRegistry: createDefaultToolRegistry(),
    sessionStore,
    eventStore,
    commandRunner: new CommandRunner({ repoPath }),
    permissionManager,
    patchManager: new PatchManager({ repoPath }),
    contextBuilder: new ContextBuilder({ repoPath }),
    onProgress: writeAgentProgress,
    ...(prompt ? { askUser: prompt } : {}),
  });

  const result = await loop.run({
    userGoal,
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    autoApprove: true,
    nonInteractive: options.nonInteractive === true,
    keepSessionActive: options.keepSessionActive === true,
  });

  return {
    success: result.success,
    sessionId: result.sessionId,
    mode: "AGENT_LOOP",
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function createOpenAICompatibleClient(repoPath: string, options: AgentCliOptions): Promise<OpenAICompatibleClient> {
  const resolvedConfig = resolveLlmConfig(await loadAgentConfig(repoPath), {
    baseUrl: options.baseUrl,
    model: options.model,
  });

  return new OpenAICompatibleClient(resolvedConfig.openai);
}

async function runDirectAnswerTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const { sessionStore, eventStore } = createStores(repoPath, options.eventStream === true);
  let sessionId = options.session;

  if (sessionId) {
    await sessionStore.ensureSession(sessionId);
    await eventStore.init();
  } else {
    const created = await sessionStore.createSession({ title: userGoal.slice(0, 80) });
    sessionId = created.sessionId;
    await eventStore.appendEvent(sessionId, {
      type: "SESSION_CREATED",
      payload: {
        title: created.title,
        repoPath: created.repoPath,
        baseCommit: created.baseCommit,
      },
    });
  }

  process.stdout.write(`[session] ${sessionId}\n`);

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 18, maxChars: 8_000 })
    .catch(() => "(none)");

  await sessionStore.appendRecord(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });
  await eventStore.appendEvent(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });

  const client = await createOpenAICompatibleClient(repoPath, options);
  const result = await client.completeText({ userGoal, context: sessionMemory, mode: "direct" });

  if (!result.success || !result.text) {
    const error = result.error ?? "Direct answer failed";
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "DIRECT_ANSWER" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "DIRECT_ANSWER",
      summary: error,
      error,
    };
  }

  process.stdout.write(`[answer]\n${result.text}\n`);

  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: result.text },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: result.text },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary: result.text,
      success: true,
      mode: "DIRECT_ANSWER",
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "DIRECT_ANSWER",
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "DIRECT_ANSWER",
    summary: result.text,
  };
}

async function runWebAnswerTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const { sessionStore, eventStore } = createStores(repoPath, options.eventStream === true);
  let sessionId = options.session;

  if (sessionId) {
    await sessionStore.ensureSession(sessionId);
    await eventStore.init();
  } else {
    const created = await sessionStore.createSession({ title: userGoal.slice(0, 80) });
    sessionId = created.sessionId;
    await eventStore.appendEvent(sessionId, {
      type: "SESSION_CREATED",
      payload: {
        title: created.title,
        repoPath: created.repoPath,
        baseCommit: created.baseCommit,
        mode: "WEB_ANSWER",
      },
    });
  }

  process.stdout.write(`[session] ${sessionId}\n`);

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 18, maxChars: 8_000 })
    .catch(() => "(none)");

  await sessionStore.appendRecord(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });
  await eventStore.appendEvent(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });

  const client = await createOpenAICompatibleClient(repoPath, options);
  const webPlan = await planWebQuestion({
    userGoal,
    sessionMemory,
    client,
  });
  const registry = createDefaultToolRegistry();
  const toolContext: ToolContext = {
    repoPath,
    sessionId,
    sessionStore,
    eventStore,
    maxOutputChars: 12_000,
    autoApprove: true,
    nonInteractive: true,
  };

  const searchQueries = webPlan.searchQueries;
  const searchResults: Array<{ query: string; result: ToolResult<unknown> }> = [];
  let sources: WebAnswerSource[] = [];

  for (const query of searchQueries) {
    process.stdout.write("[tool] web_search\n");
    const result = await registry.execute("web_search", {
      query,
      maxResults: 5,
    }, toolContext);
    searchResults.push({ query, result });
    sources = mergeWebSources(sources, extractWebSources(result, query));

    if (sources.length >= 6) {
      break;
    }
  }

  sources = rankWebSources(sources).slice(0, 6);

  for (const source of sources.slice(0, 3)) {
    process.stdout.write("[tool] fetch_url\n");
    const fetchResult = await registry.execute("fetch_url", {
      url: source.url,
      maxBytes: 120_000,
      extractText: true,
    }, {
      ...toolContext,
      maxOutputChars: 8_000,
    });
    const fetchedSource = extractFetchedSource(fetchResult);
    if (fetchedSource) {
      source.fetch = fetchedSource;
    } else if (fetchResult.error) {
      source.fetchError = fetchResult.error.message;
    }
  }

  const result = await client.completeText({
    userGoal: webPlan.standaloneQuestion,
    context: buildWebAnswerContext({
      userGoal,
      webPlan,
      sessionMemory,
      searchQueries,
      searchResults,
      sources,
    }),
    mode: "web",
  });

  if (!result.success || !result.text) {
    const error = result.error ?? "Web answer failed";
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "WEB_ANSWER" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "WEB_ANSWER",
      summary: error,
      error,
    };
  }

  process.stdout.write(`[answer]\n${result.text}\n`);

  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: result.text },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: result.text },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary: result.text,
      success: true,
      mode: "WEB_ANSWER",
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "WEB_ANSWER",
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "WEB_ANSWER",
    summary: result.text,
  };
}

interface WebAnswerSource {
  title: string;
  url: string;
  snippet: string;
  query?: string;
  fetch?: FetchedWebSource;
  fetchError?: string;
}

interface FetchedWebSource {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  outputTruncated: boolean;
}

function extractWebSources(searchResult: ToolResult<unknown>, query?: string): WebAnswerSource[] {
  if (!searchResult.success || !isWebSearchData(searchResult.data)) {
    return [];
  }

  return searchResult.data.results.map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    ...(query ? { query } : {}),
  }));
}

function extractFetchedSource(fetchResult: ToolResult<unknown>): FetchedWebSource | undefined {
  if (!fetchResult.success || !isFetchUrlData(fetchResult.data)) {
    return undefined;
  }

  return {
    finalUrl: fetchResult.data.finalUrl,
    status: fetchResult.data.status,
    contentType: fetchResult.data.contentType,
    text: fetchResult.data.text,
    truncated: fetchResult.data.truncated,
    outputTruncated: fetchResult.data.outputTruncated,
  };
}

function buildWebAnswerContext(input: {
  userGoal: string;
  webPlan: WebQuestionPlan;
  sessionMemory: string;
  searchQueries: string[];
  searchResults: Array<{ query: string; result: ToolResult<unknown> }>;
  sources: WebAnswerSource[];
}): string {
  const lines = [
    "Runtime context:",
    formatRuntimeContext(),
    "",
    "Conversation context:",
    input.sessionMemory,
    "",
    `Original web question: ${input.userGoal}`,
    `Standalone web question: ${input.webPlan.standaloneQuestion}`,
    `Answer scope: ${input.webPlan.answerScope}`,
    `Needs live/current data: ${input.webPlan.needsLiveData}`,
    input.webPlan.plannerError ? `Planner fallback reason: ${input.webPlan.plannerError}` : undefined,
    "",
    "Source hints:",
    ...(input.webPlan.sourceHints.length > 0 ? input.webPlan.sourceHints.map((hint) => `- ${hint}`) : ["- (none)"]),
    "",
    "Resolved search queries:",
    ...input.searchQueries.map((query, index) => `${index + 1}. ${query}`),
    "",
    "Answering rules:",
    ...(input.webPlan.answerInstructions.length > 0
      ? input.webPlan.answerInstructions.map((instruction) => `- ${instruction}`)
      : ["- Only answer facts supported by the gathered sources."]),
    "",
    "Web tool results:",
  ].filter((line): line is string => line !== undefined);

  const failedSearches = input.searchResults.filter((entry) => !entry.result.success);
  if (input.searchResults.length > 0 && failedSearches.length === input.searchResults.length) {
    for (const entry of failedSearches) {
      lines.push(`web_search failed for "${entry.query}": ${entry.result.error?.message ?? "unknown error"}`);
    }
  } else if (input.sources.length === 0) {
    lines.push("web_search returned no results.");
  } else {
    input.sources.forEach((source, index) => {
      lines.push("");
      lines.push(`[source ${index + 1}] ${source.title}`);
      if (source.query) {
        lines.push(`searchQuery: ${source.query}`);
      }
      lines.push(`url: ${source.url}`);
      if (source.snippet) {
        lines.push(`snippet: ${source.snippet}`);
      }

      if (source.fetch) {
        lines.push(`fetchedUrl: ${source.fetch.finalUrl}`);
        lines.push(`status: ${source.fetch.status}`);
        lines.push(`contentType: ${source.fetch.contentType}`);
        lines.push(`truncated: ${source.fetch.truncated || source.fetch.outputTruncated}`);
        lines.push("text:");
        lines.push(limitText(source.fetch.text, 4_000));
      } else if (source.fetchError) {
        lines.push(`fetch_url failed: ${source.fetchError}`);
      }
    });
  }

  return lines.join("\n");
}

function mergeWebSources(left: WebAnswerSource[], right: WebAnswerSource[]): WebAnswerSource[] {
  const seen = new Set(left.map((source) => normalizeUrlForDedupe(source.url)));
  const merged = [...left];

  for (const source of right) {
    const key = normalizeUrlForDedupe(source.url);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(source);
    }
  }

  return merged;
}

function rankWebSources(sources: WebAnswerSource[]): WebAnswerSource[] {
  return [...sources].sort((left, right) => scoreWebSource(right) - scoreWebSource(left));
}

function scoreWebSource(source: WebAnswerSource): number {
  const value = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
  let score = 0;

  if (containsAnyText(value, ["fifa.com", "the-afc.com", "jfa.jp"])) {
    score += 10;
  }
  if (containsAnyText(value, ["espn", "bbc", "reuters", "apnews", "sofascore", "flashscore", "fotmob"])) {
    score += 5;
  }
  if (containsAnyText(value, ["score", "scores", "result", "results", "比分", "赛果", "赛程"])) {
    score += 3;
  }
  if (containsAnyText(value, ["official", "官网", "官方"])) {
    score += 2;
  }

  return score;
}

function containsAnyText(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle.toLowerCase()));
}

function normalizeUrlForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isWebSearchData(value: unknown): value is {
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
} {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return false;
  }

  return value.results.every((item) => isRecord(item)
    && typeof item.title === "string"
    && typeof item.url === "string"
    && typeof item.snippet === "string");
}

function isFetchUrlData(value: unknown): value is {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  outputTruncated: boolean;
} {
  return isRecord(value)
    && typeof value.finalUrl === "string"
    && typeof value.status === "number"
    && typeof value.contentType === "string"
    && typeof value.text === "string"
    && typeof value.truncated === "boolean"
    && typeof value.outputTruncated === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

function writeAgentProgress(event: AgentProgressEvent): void {
  switch (event.type) {
    case "session":
      process.stdout.write(`[session] ${event.sessionId}\n`);
      break;
    case "plan":
      process.stdout.write(`[plan] ${event.message}\n`);
      break;
    case "tool":
      process.stdout.write(`[tool] ${event.toolName}\n`);
      break;
    case "patch":
      process.stdout.write(`[patch] ${event.description}\n`);
      break;
    case "command":
      process.stdout.write(`[command] ${event.command}\n`);
      break;
    case "ask_user":
      process.stdout.write(`[ask] ${event.message}\n`);
      break;
    case "diff":
      process.stdout.write("[diff] generated\n");
      break;
    case "summary":
      process.stdout.write(`[summary] ${event.summary}\n`);
      break;
    case "error":
      process.stdout.write(`[error] ${event.message}\n`);
      break;
  }
}

async function readGitDiff(repoPath: string): Promise<string> {
  const result = await createDefaultToolRegistry().execute("git_diff", {}, { repoPath });
  if (result.success && isGitDiffData(result.data)) {
    return result.data.diff;
  }

  return `[git] ${result.error?.message ?? "Unable to read git diff"}\n`;
}

async function readRepoState(repoPath: string): Promise<string> {
  try {
    const state = await new RepoStateAnalyzer({ repoPath }).analyze();
    return formatRepoState(state);
  } catch (error) {
    return `[status] ${errorToMessage(error)}`;
  }
}

async function readGitSnapshot(repoPath: string): Promise<GitSnapshot> {
  const git = new GitManager({ repoPath });
  if (!(await git.isGitRepository().catch(() => false))) {
    return { changedFiles: [], diffStat: null };
  }

  const [changedFiles, diffSummary] = await Promise.all([
    git.getChangedFiles().catch(() => []),
    git.generateDiffSummary().catch(() => null),
  ]);

  return {
    changedFiles,
    diffStat: diffSummary?.stat || null,
  };
}

async function appendTaskChangeLog(
  repoPath: string,
  input: {
    userGoal: string;
    result: CliTaskResult;
    beforeSnapshot: GitSnapshot;
  },
): Promise<TaskChangeLogEntry | undefined> {
  if (!input.result.sessionId) {
    return undefined;
  }

  const afterSnapshot = await readGitSnapshot(repoPath);
  const tests = await readTaskTests(repoPath, input.result.sessionId);
  return await new TaskChangeLogStore({ repoPath }).append({
    sessionId: input.result.sessionId,
    task: input.userGoal,
    mode: input.result.mode,
    success: input.result.success,
    summary: limitText(input.result.summary, 2_000),
    beforeChangedFiles: input.beforeSnapshot.changedFiles,
    currentChangedFiles: afterSnapshot.changedFiles,
    diffStat: afterSnapshot.diffStat,
    tests,
    ...(input.result.error ? { error: input.result.error } : {}),
    metadata: {
      beforeDiffStat: input.beforeSnapshot.diffStat,
    },
    });
}

async function buildDoctorReport(repoPath: string): Promise<JsonObject> {
  const [gitVersion, rgVersion, pnpmVersion, repoState, configResult, sessions, recentLogs, recentChanges] = await Promise.all([
    readCommandVersion("git", ["--version"]),
    readCommandVersion("rg", ["--version"]),
    readPnpmVersion(),
    new RepoStateAnalyzer({ repoPath }).analyze().catch((error: unknown) => ({ error: errorToMessage(error) })),
    readDoctorConfig(repoPath),
    createStores(repoPath).sessionStore.listSessions().catch(() => []),
    readRuntimeLogs(repoPath, { limit: 1 }).catch(() => []),
    new TaskChangeLogStore({ repoPath }).list(1).catch(() => []),
  ]);

  return toJsonObject({
    timestamp: new Date().toISOString(),
    repoPath,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    commands: {
      git: gitVersion,
      rg: rgVersion,
      pnpm: pnpmVersion,
    },
    config: configResult,
    repository: repoState,
    storage: {
      sessionCount: sessions.length,
      latestSession: sessions[0] ?? null,
      hasRuntimeLogs: recentLogs.length > 0,
      hasChangeLog: recentChanges.length > 0,
    },
  });
}

async function readDoctorConfig(repoPath: string): Promise<unknown> {
  try {
    const config = await loadAgentConfig(repoPath);
    const resolved = resolveLlmConfig(config);
    return {
      loaded: true,
      config: redactAgentConfig(config),
      resolved: {
        baseUrl: resolved.openai.baseUrl ?? null,
        model: resolved.openai.model ?? null,
        hasApiKey: Boolean(resolved.openai.apiKey),
        temperature: resolved.openai.temperature ?? null,
        maxTokens: resolved.openai.maxTokens ?? null,
        timeoutMs: resolved.openai.timeoutMs ?? null,
      },
      warnings: [
        resolved.openai.apiKey ? null : "Missing API key. Configure mini-agent.config.json or MINI_AGENT_API_KEY.",
        resolved.openai.model ? null : "Missing model. Configure mini-agent.config.json or MINI_AGENT_MODEL.",
      ].filter(Boolean),
    };
  } catch (error) {
    return {
      loaded: false,
      error: errorToMessage(error),
    };
  }
}

async function readCommandVersion(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execa(command, args, {
      reject: false,
      timeout: 5_000,
      encoding: "utf8",
    });

    return {
      ok: result.exitCode === 0,
      output: firstNonEmptyLine([result.stdout, result.stderr].join("\n")),
    };
  } catch (error) {
    return {
      ok: false,
      output: errorToMessage(error),
    };
  }
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

async function readPnpmVersion(): Promise<{ ok: boolean; output: string }> {
  const direct = await readCommandVersion("pnpm", ["--version"]);
  if (direct.ok) {
    return direct;
  }

  const viaCorepack = await readCommandVersion("corepack", ["pnpm", "--version"]);
  if (viaCorepack.ok) {
    return {
      ok: true,
      output: viaCorepack.output ? `corepack pnpm ${viaCorepack.output}` : "corepack pnpm available",
    };
  }

  return direct.output ? direct : viaCorepack;
}

async function readTaskTests(repoPath: string, sessionId: string): Promise<TaskChangeTestResult[]> {
  const { eventStore } = createStores(repoPath);
  const events = await eventStore.readEvents(sessionId).catch(() => []);

  return events
    .filter(isTestEventRecord)
    .slice(-10)
    .map((event): TaskChangeTestResult => {
      const payload = event.payload;
      return {
        type: event.type === "TEST_PASSED" ? "TEST_PASSED" : "TEST_FAILED",
        command: typeof payload.command === "string" ? payload.command : "",
        exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
      };
    });
}

function isTestEventRecord(
  event: EventRecord,
): event is EventRecord & { type: "TEST_PASSED" | "TEST_FAILED" } {
  return event.type === "TEST_PASSED" || event.type === "TEST_FAILED";
}

function parseJsonInput(value: string): ToolResult<unknown> {
  try {
    return { success: true, data: JSON.parse(value) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: {
        code: "INVALID_JSON",
        message: `Invalid JSON input: ${message}`,
      },
    };
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonError(error: unknown): void {
  writeJson({
    success: false,
    error: {
      code: errorToCode(error, "CLI_ERROR"),
      message: errorToMessage(error),
      details: errorToDetails(error),
    },
  });
}

async function runJsonAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    await createRuntimeLogger(process.cwd()).error("cli", "CLI action failed", {
      code: errorToCode(error, "CLI_ERROR"),
      message: errorToMessage(error),
      details: errorToDetails(error) ?? null,
    }).catch(() => undefined);
    writeJsonError(error);
    process.exitCode = 1;
  }
}

function createStores(repoPath: string, eventStream = false): { sessionStore: SessionStore; eventStore: EventStore } {
  return {
    sessionStore: new SessionStore({ repoPath }),
    eventStore: new EventStore({
      repoPath,
      ...(eventStream ? { onEvent: writeStructuredEvent } : {}),
    }),
  };
}

function writeStructuredEvent(event: unknown): void {
  process.stdout.write(`MINI_AGENT_EVENT ${JSON.stringify(event)}\n`);
}

function parseOptionalLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

function parseLogLevel(value: string): LogLevel {
  const normalized = value.toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }

  throw new Error(`Expected log level debug, info, warn, or error, got: ${value}`);
}

function parseNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got: ${value}`);
  }

  return parsed;
}

async function readPatchInput(repoPath: string, patchFile?: string): Promise<string> {
  if (patchFile && patchFile.trim().length > 0) {
    const absolutePath = resolveRepoPath(repoPath, patchFile);
    return await fs.readFile(absolutePath, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error("Patch file is required when stdin is not piped");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function commandResultToPayload(result: CommandResult): JsonObject {
  return toJsonObject({
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    success: result.success,
    timedOut: result.timedOut,
    truncated: result.truncated,
    error: result.error,
  });
}

function isTestCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return [
    "mvn test",
    "npm test",
    "pnpm test",
    "yarn test",
    "go test",
    "pytest",
    "gradle test",
  ].some((keyword) => normalized.includes(keyword));
}

function isGitDiffData(value: unknown): value is { diff: string } {
  return typeof value === "object"
    && value !== null
    && "diff" in value
    && typeof value.diff === "string";
}

function formatSessionRecord(record: SessionRecord): string {
  const preview = compactPayload(record.payload, 220);
  return `[history] ${record.timestamp} ${record.type} ${preview}`;
}

function formatResumeSessionLine(index: number, session: SessionMeta, lastUserMessage?: string): string {
  const number = `${String(index).padStart(2, " ")}.`;
  const status = session.status.padEnd(8, " ");
  const updatedAt = formatLocalMinute(session.updatedAt);
  const label = lastUserMessage ? "last" : "title";
  const preview = limitSingleLine(lastUserMessage ?? session.title, 72);

  return `${number} ${status} ${updatedAt} ${label}: ${preview}\n    id: ${session.sessionId}`;
}

function formatEventRecord(record: EventRecord): string {
  const preview = compactPayload(record.payload, 220);
  return `[event] ${record.timestamp} ${record.type} ${preview}`;
}

function formatLogRecord(record: LogRecord): string {
  const session = record.sessionId ? ` session=${record.sessionId}` : "";
  const details = record.details === undefined ? "" : ` ${compactPayload(record.details, 220)}`;
  return `[log] ${record.timestamp} ${record.level.toUpperCase()} ${record.component}${session} ${record.message}${details}`;
}

function formatTaskChangeLogEntry(entry: TaskChangeLogEntry): string {
  const files = entry.currentChangedFiles.length > 0
    ? ` files=${entry.currentChangedFiles.slice(0, 8).join(",")}`
    : "";
  const stat = entry.diffStat ? ` diff="${entry.diffStat}"` : "";
  const tests = entry.tests.length > 0
    ? ` tests=${entry.tests.map((test) => `${test.type}:${test.command}:${String(test.exitCode)}`).join("|")}`
    : "";
  return `[change] ${entry.timestamp} ${entry.success ? "OK" : "FAIL"} ${entry.mode} session=${entry.sessionId}${files}${stat}${tests} task=${entry.task}`;
}

function compactPayload(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }

  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

function readPayloadString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatLocalMinute(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function limitSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}


async function isDirectCliEntry(): Promise<boolean> {
  const currentFile = fileURLToPath(import.meta.url);
  const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

  if (!invokedFile) {
    return false;
  }

  try {
    const [currentRealPath, invokedRealPath] = await Promise.all([
      fs.realpath(currentFile),
      fs.realpath(invokedFile),
    ]);
    return currentRealPath === invokedRealPath;
  } catch {
    return currentFile === invokedFile;
  }
}

if (await isDirectCliEntry()) {
  await createProgram().parseAsync(process.argv);
}
