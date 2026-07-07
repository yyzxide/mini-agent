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
import { looksLikeRepositoryAnalysisTask, routeTask } from "../agent/TaskRouter.js";
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
import type { LlmCallMetrics } from "../llm/OpenAICompatibleClient.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import {
  applyReviewVerification,
  buildLoadedReviewFile,
  extractRelatedReviewFilePaths,
  extractLikelyReviewFilePath,
  formatReviewFileForPrompt,
  groundCodeReviewResponse,
} from "../review/CodeReview.js";
import type {
  GroundedCodeReviewFinding,
  GroundedCodeReviewResult,
  LoadedReviewFile,
  ReviewFileChunk,
} from "../review/CodeReview.js";
import { EventStore } from "../session/EventStore.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import { SessionStore } from "../session/SessionStore.js";
import { TaskChangeLogStore } from "../session/TaskChangeLogStore.js";
import type { TaskChangeLogEntry, TaskChangeMode, TaskChangeTestResult } from "../session/TaskChangeLogStore.js";
import type { EventRecord, JsonObject, SessionMeta, SessionRecord } from "../session/SessionTypes.js";
import { ToolRegistry, createDefaultToolRegistry } from "../tools/ToolRegistry.js";
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
import {
  isShortFollowUpQuestion,
  planWebQuestion,
  resolveFollowUpQuestion,
} from "../web/WebQuestionPlanner.js";

const VERSION = "0.1.0";
const INTERACTIVE_RESUME_LIST_LIMIT = 10;
const INTERACTIVE_SLASH_COMMANDS = [
  { command: "/help", usage: "/help", description: "Show this help." },
  { command: "/new", usage: "/new", description: "Start a new conversation session." },
  { command: "/review", usage: "/review <file>", description: "Run a focused code review for one file." },
  { command: "/resume", usage: "/resume [n|id]", description: "Pick from recent sessions, or switch by number/id." },
  { command: "/session", usage: "/session", description: "Show current session metadata." },
  { command: "/summary", usage: "/summary", description: "Show a compact summary of the current session." },
  { command: "/sessions", usage: "/sessions", description: "List local sessions." },
  { command: "/history", usage: "/history [n]", description: "Show recent session records." },
  { command: "/events", usage: "/events [n]", description: "Show recent session events." },
  { command: "/logs", usage: "/logs [n]", description: "Show recent runtime logs." },
  { command: "/changes", usage: "/changes [n]", description: "Show recent task change-log entries." },
  { command: "/compact", usage: "/compact", description: "Write a compact memory record for this session." },
  { command: "/status", usage: "/status", description: "Show current agent/session status." },
  { command: "/repo", usage: "/repo", description: "Show repository state summary." },
  { command: "/diff", usage: "/diff", description: "Show git diff." },
  { command: "/clear", usage: "/clear", description: "Clear the terminal." },
  { command: "/exit", usage: "/exit", description: "Finish this session and exit." },
] as const;

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
  metadata?: JsonObject;
}

interface RepositoryAnalysisFileEvidence {
  path: string;
  role: "readme" | "build" | "config" | "source";
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

interface RepositoryAnalysisEvidence {
  listedItems: Array<{ path: string; type: "file" | "directory" }>;
  readFiles: RepositoryAnalysisFileEvidence[];
  gitStatus: string;
  gitDiff: string;
}

interface GitSnapshot {
  changedFiles: string[];
  diffStat: string | null;
}

interface SessionOverview extends SessionMeta {
  lastUserMessage?: string;
  latestSummary?: string;
}

interface SessionSummaryOutput {
  sessionId: string;
  title: string;
  status: string;
  messageCount: number;
  eventCount: number;
  lastUserMessage?: string;
  latestSummary?: string;
  summary: string;
  persisted: boolean;
}

interface SessionAgentStatusOutput {
  sessionId: string;
  repoPath: string;
  title: string;
  sessionStatus: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  eventCount: number;
  lastMode?: TaskChangeMode;
  lastUserMessage?: string;
  latestSummary?: string;
  llm: {
    configuredModel: string | null;
    configuredBaseUrl: string | null;
    configuredMaxTokens: number | null;
    calls: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    cachedPromptTokens: number | null;
    reasoningTokens: number | null;
    remainingContextTokens: null;
    usageAvailable: boolean;
  };
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

  program
    .command("review")
    .description("Run a file-focused code review")
    .argument("<filePath>", "Repository-relative file path to review")
    .option("--session <sessionId>", "Session id used for the task")
    .option("--model <model>", "Override MINI_AGENT_MODEL for OpenAI-compatible clients")
    .option("--base-url <url>", "Override MINI_AGENT_BASE_URL for OpenAI-compatible clients")
    .option("--event-stream", "Print structured MINI_AGENT_EVENT lines for local integrations")
    .action(async (filePath: string, options: AgentCliOptions) => {
      const trimmedPath = filePath.trim();
      if (trimmedPath.length === 0) {
        throw new Error("File path cannot be empty.");
      }

      const result = await runCodeReviewTask(process.cwd(), trimmedPath, options);
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
        writeJson(await listSessionOverviews(sessionStore));
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

  sessionCommand
    .command("summary")
    .description("Summarize a session's recent memory")
    .argument("<sessionId>", "Session id")
    .option("--write", "Persist the summary as a MEMORY_COMPACTION record")
    .action(async (sessionId: string, options: { write?: boolean }) => {
      await runJsonAction(async () => {
        const { sessionStore, eventStore } = createStores(process.cwd());
        writeJson(await summarizeSession(sessionStore, eventStore, sessionId, {
          persist: options.write === true,
        }));
      });
    });

  sessionCommand
    .command("status")
    .description("Show agent/session status including LLM usage when available")
    .argument("<sessionId>", "Session id")
    .action(async (sessionId: string) => {
      await runJsonAction(async () => {
        const { sessionStore } = createStores(process.cwd());
        writeJson(await buildSessionAgentStatus(process.cwd(), sessionStore, sessionId));
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
    .command("repo")
    .description("Print repository state summary")
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

export function completeInteractiveInput(line: string): [string[], string] {
  const current = line.trimStart();
  if (!current.startsWith("/")) {
    return [[], line];
  }

  if (/\s/.test(current)) {
    return [[], line];
  }

  const commands = INTERACTIVE_SLASH_COMMANDS.map((item) => item.command);
  if (current === "/") {
    return [commands, current];
  }

  const matches = commands.filter((command) => command.startsWith(current));
  return [matches, current];
}

async function startInteractive(repoPath: string, resumeSessionId?: string): Promise<void> {
  const stores = createStores(repoPath);
  let currentSessionId = resumeSessionId
    ? await ensureInteractiveSession(stores.sessionStore, stores.eventStore, resumeSessionId)
    : await createInteractiveSession(stores.sessionStore, stores.eventStore, "Interactive session");

  process.stdout.write("Mini Coding Agent\n");
  process.stdout.write(`Current repo: ${repoPath}\n`);
  process.stdout.write(`Current session: ${currentSessionId}\n`);
  process.stdout.write("Type your coding task, or use /help, /review, /exit, /new, /resume, /status, /repo, /sessions.\n\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completeInteractiveInput,
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

    case "/review": {
      const reviewTarget = args.join(" ").trim();
      if (!reviewTarget) {
        process.stdout.write("[review] Usage: /review <repository-file-path>\n");
        return { sessionId: input.currentSessionId, exit: false };
      }

      await runCodeReviewTask(input.repoPath, reviewTarget, {
        session: input.currentSessionId,
        keepSessionActive: true,
      });
      return { sessionId: input.currentSessionId, exit: false };
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

    case "/summary": {
      const summary = await summarizeSession(
        input.stores.sessionStore,
        input.stores.eventStore,
        input.currentSessionId,
      );
      process.stdout.write(`[summary] ${summary.summary}\n`);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/diff": {
      const diff = await readGitDiff(input.repoPath);
      process.stdout.write(diff.length > 0 ? diff : "[diff] No changes.\n");
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/status": {
      const status = await buildSessionAgentStatus(input.repoPath, input.stores.sessionStore, input.currentSessionId);
      process.stdout.write(`${formatSessionAgentStatus(status)}\n`);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/repo":
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
    ...INTERACTIVE_SLASH_COMMANDS.map((item) => `  ${item.usage.padEnd(18, " ")} ${item.description}`),
    "",
    "Tip: press Tab to complete slash commands.",
    "",
  ].join("\n"));
}

async function printInteractiveResumeList(sessionStore: SessionStore): Promise<void> {
  const sessions = await listSessionOverviews(sessionStore);
  if (sessions.length === 0) {
    process.stdout.write("[resume] No sessions yet.\n");
    return;
  }

  const recentSessions = sessions.slice(0, INTERACTIVE_RESUME_LIST_LIMIT);
  process.stdout.write(`[resume] Recent sessions (${recentSessions.length} of ${sessions.length}):\n`);
  for (const [index, session] of recentSessions.entries()) {
    process.stdout.write(`${formatResumeSessionLine(index + 1, session)}\n`);
  }

  process.stdout.write("[resume] Enter a number/id to resume, or press Enter to cancel. Use /sessions for the full list.\n");
}

async function printInteractiveSessions(sessionStore: SessionStore): Promise<void> {
  const sessions = await listSessionOverviews(sessionStore);
  if (sessions.length === 0) {
    process.stdout.write("[sessions] No sessions yet.\n");
    return;
  }

  for (const session of sessions) {
    process.stdout.write(`${formatInteractiveSessionLine(session)}\n`);
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

async function readLatestSessionSummary(sessionStore: SessionStore, sessionId: string): Promise<string | undefined> {
  const records = await sessionStore.readRecords(sessionId).catch(() => []);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) {
      continue;
    }

    if (record.type === "TASK_SUMMARY") {
      const summary = readPayloadString(record.payload, "summary");
      if (summary) {
        return summary;
      }
    }

    if (record.type === "MEMORY_COMPACTION") {
      const summary = readPayloadString(record.payload, "summary");
      if (summary) {
        return summary;
      }
    }

    if (record.type === "ASSISTANT_MESSAGE") {
      const content = readPayloadString(record.payload, "content");
      if (content) {
        return content;
      }
    }
  }

  return undefined;
}

async function readLastTaskMode(sessionStore: SessionStore, sessionId: string): Promise<TaskChangeMode | undefined> {
  const records = await sessionStore.readRecords(sessionId).catch(() => []);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "TASK_SUMMARY") {
      continue;
    }

    const mode = record.payload.mode;
    if (mode === "DIRECT_ANSWER" || mode === "WEB_ANSWER" || mode === "CODE_REVIEW" || mode === "AGENT_LOOP") {
      return mode;
    }
  }

  return undefined;
}

async function buildSessionOverview(sessionStore: SessionStore, session: SessionMeta): Promise<SessionOverview> {
  const [lastUserMessage, latestSummary] = await Promise.all([
    readLastUserMessage(sessionStore, session.sessionId),
    readLatestSessionSummary(sessionStore, session.sessionId),
  ]);

  return {
    ...session,
    ...(lastUserMessage ? { lastUserMessage } : {}),
    ...(latestSummary ? { latestSummary } : {}),
  };
}

async function listSessionOverviews(sessionStore: SessionStore): Promise<SessionOverview[]> {
  const sessions = await sessionStore.listSessions();
  return await Promise.all(sessions.map(async (session) => await buildSessionOverview(sessionStore, session)));
}

async function summarizeSession(
  sessionStore: SessionStore,
  eventStore: EventStore,
  sessionId: string,
  options: { persist?: boolean } = {},
): Promise<SessionSummaryOutput> {
  const initialMeta = await sessionStore.getSessionMeta(sessionId);
  const memory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 20_000 });
  const summary = new MessageCompressor({ maxChars: 4_000 }).compress(memory);
  const [lastUserMessage, latestSummaryBeforePersist] = await Promise.all([
    readLastUserMessage(sessionStore, sessionId),
    readLatestSessionSummary(sessionStore, sessionId),
  ]);

  if (options.persist === true) {
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
  }

  const meta = options.persist === true
    ? await sessionStore.getSessionMeta(sessionId)
    : initialMeta;
  const latestSummary = options.persist === true
    ? summary
    : latestSummaryBeforePersist;

  return {
    sessionId: meta.sessionId,
    title: meta.title,
    status: meta.status,
    messageCount: meta.messageCount,
    eventCount: meta.eventCount,
    ...(lastUserMessage ? { lastUserMessage } : {}),
    ...(latestSummary ? { latestSummary } : {}),
    summary,
    persisted: options.persist === true,
  };
}

async function buildSessionAgentStatus(
  repoPath: string,
  sessionStore: SessionStore,
  sessionId: string,
): Promise<SessionAgentStatusOutput> {
  const [meta, records, lastUserMessage, latestSummary, lastMode, resolvedConfig] = await Promise.all([
    sessionStore.getSessionMeta(sessionId),
    sessionStore.readRecords(sessionId),
    readLastUserMessage(sessionStore, sessionId),
    readLatestSessionSummary(sessionStore, sessionId),
    readLastTaskMode(sessionStore, sessionId),
    loadAgentConfig(repoPath).then((config) => resolveLlmConfig(config)).catch(() => undefined),
  ]);

  const usageRecords = records
    .filter((record): record is SessionRecord & { type: "LLM_USAGE" } => record.type === "LLM_USAGE");
  const usageSummary = summarizeLlmUsageRecords(usageRecords);
  const lastRecordedModel = findLastRecordedLlmModel(usageRecords);

  return {
    sessionId: meta.sessionId,
    repoPath: meta.repoPath,
    title: meta.title,
    sessionStatus: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    eventCount: meta.eventCount,
    ...(lastMode ? { lastMode } : {}),
    ...(lastUserMessage ? { lastUserMessage } : {}),
    ...(latestSummary ? { latestSummary } : {}),
    llm: {
      configuredModel: resolvedConfig?.openai.model ?? lastRecordedModel ?? null,
      configuredBaseUrl: resolvedConfig?.openai.baseUrl ?? null,
      configuredMaxTokens: resolvedConfig?.openai.maxTokens ?? null,
      calls: usageSummary.calls,
      promptTokens: usageSummary.promptTokens,
      completionTokens: usageSummary.completionTokens,
      totalTokens: usageSummary.totalTokens,
      cachedPromptTokens: usageSummary.cachedPromptTokens,
      reasoningTokens: usageSummary.reasoningTokens,
      remainingContextTokens: null,
      usageAvailable: usageSummary.usageAvailable,
    },
  };
}

function findLastRecordedLlmModel(records: Array<SessionRecord & { type: "LLM_USAGE" }>): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const model = readPayloadString(records[index]?.payload ?? {}, "model");
    if (model) {
      return model;
    }
  }

  return undefined;
}

function summarizeLlmUsageRecords(
  records: Array<SessionRecord & { type: "LLM_USAGE" }>,
): {
    calls: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    cachedPromptTokens: number | null;
    reasoningTokens: number | null;
    usageAvailable: boolean;
  } {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedPromptTokens = 0;
  let reasoningTokens = 0;
  let hasPromptTokens = false;
  let hasCompletionTokens = false;
  let hasTotalTokens = false;
  let hasCachedPromptTokens = false;
  let hasReasoningTokens = false;
  let usageAvailable = false;

  for (const record of records) {
    if (record.payload.usageAvailable === true) {
      usageAvailable = true;
    }

    const prompt = readPayloadNumber(record.payload, "promptTokens");
    if (prompt !== undefined) {
      promptTokens += prompt;
      hasPromptTokens = true;
    }

    const completion = readPayloadNumber(record.payload, "completionTokens");
    if (completion !== undefined) {
      completionTokens += completion;
      hasCompletionTokens = true;
    }

    const total = readPayloadNumber(record.payload, "totalTokens");
    if (total !== undefined) {
      totalTokens += total;
      hasTotalTokens = true;
    }

    const cachedPrompt = readPayloadNumber(record.payload, "cachedPromptTokens");
    if (cachedPrompt !== undefined) {
      cachedPromptTokens += cachedPrompt;
      hasCachedPromptTokens = true;
    }

    const reasoning = readPayloadNumber(record.payload, "reasoningTokens");
    if (reasoning !== undefined) {
      reasoningTokens += reasoning;
      hasReasoningTokens = true;
    }
  }

  return {
    calls: records.length,
    promptTokens: hasPromptTokens ? promptTokens : null,
    completionTokens: hasCompletionTokens ? completionTokens : null,
    totalTokens: hasTotalTokens ? totalTokens : null,
    cachedPromptTokens: hasCachedPromptTokens ? cachedPromptTokens : null,
    reasoningTokens: hasReasoningTokens ? reasoningTokens : null,
    usageAvailable,
  };
}

function formatSessionAgentStatus(status: SessionAgentStatusOutput): string {
  const usageLine = [
    `calls=${String(status.llm.calls)}`,
    `prompt=${status.llm.promptTokens ?? "unavailable"}`,
    `completion=${status.llm.completionTokens ?? "unavailable"}`,
    `total=${status.llm.totalTokens ?? "unavailable"}`,
  ].join(", ");
  const advancedUsageLine = [
    `cached_prompt=${status.llm.cachedPromptTokens ?? "unavailable"}`,
    `reasoning=${status.llm.reasoningTokens ?? "unavailable"}`,
  ].join(", ");

  return [
    "Agent status:",
    `- session: ${status.sessionId}`,
    `- title: ${status.title}`,
    `- repo: ${status.repoPath}`,
    `- status: ${status.sessionStatus}`,
    `- created: ${formatLocalMinute(status.createdAt)}`,
    `- updated: ${formatLocalMinute(status.updatedAt)}`,
    `- messages: ${String(status.messageCount)}`,
    `- events: ${String(status.eventCount)}`,
    status.lastMode ? `- last mode: ${status.lastMode}` : undefined,
    status.lastUserMessage ? `- last user message: ${limitSingleLine(status.lastUserMessage, 120)}` : undefined,
    status.latestSummary ? `- latest summary: ${limitSingleLine(status.latestSummary, 120)}` : undefined,
    `- configured model: ${status.llm.configuredModel ?? "(unconfigured)"}`,
    `- configured base URL: ${status.llm.configuredBaseUrl ?? "(unconfigured)"}`,
    `- configured max output tokens: ${status.llm.configuredMaxTokens ?? "(unknown)"}`,
    `- LLM usage: ${usageLine}`,
    `- advanced token stats: ${advancedUsageLine}`,
    status.llm.usageAvailable
      ? "- remaining context window: unavailable (most OpenAI-compatible APIs do not expose it)."
      : "- remaining context window: unavailable (no provider usage metrics have been recorded yet).",
    "- repository summary: use /repo",
  ].filter((line): line is string => line !== undefined).join("\n");
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
  await summarizeSession(sessionStore, eventStore, sessionId, { persist: true });
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
  const route = await resolveTaskRoute(repoPath, userGoal, options.session);
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
    } else if (route.intent === "CODE_REVIEW" && options.agentLoop !== true) {
      taskResult = await runCodeReviewTask(repoPath, userGoal, options);
    } else if (route.intent === "AGENT_LOOP" && looksLikeRepositoryAnalysisTask(userGoal)) {
      taskResult = await runRepositoryAnalysisTask(repoPath, userGoal, options);
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

async function resolveTaskRoute(
  repoPath: string,
  userGoal: string,
  sessionId: string | undefined,
): Promise<{ intent: TaskChangeMode; reason: string }> {
  const baseRoute = routeTask(userGoal);
  if (!sessionId || !isShortFollowUpQuestion(userGoal)) {
    return baseRoute;
  }

  const { sessionStore } = createStores(repoPath);
  const lastMode = await readLastTaskMode(sessionStore, sessionId).catch(() => undefined);
  if (!lastMode) {
    return baseRoute;
  }

  if (baseRoute.intent === "CODE_REVIEW" || (baseRoute.intent === "AGENT_LOOP" && lastMode === "AGENT_LOOP")) {
    return baseRoute;
  }

  if ((baseRoute.intent === "AGENT_LOOP" || baseRoute.intent === "DIRECT_ANSWER") && lastMode === "WEB_ANSWER") {
    return {
      intent: "WEB_ANSWER",
      reason: "Short follow-up inherited the previous web-answer mode from the active session.",
    };
  }

  if (baseRoute.intent === "AGENT_LOOP" && lastMode === "DIRECT_ANSWER") {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Short follow-up inherited the previous direct-answer mode from the active session.",
    };
  }

  return baseRoute;
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

async function runRepositoryAnalysisTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const logger = createRuntimeLogger(repoPath);
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
        mode: "AGENT_LOOP",
        subMode: "REPOSITORY_ANALYSIS",
      },
    });
  }

  process.stdout.write(`[session] ${sessionId}\n`);

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");

  await sessionStore.appendRecord(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });
  await eventStore.appendEvent(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });

  const evidenceResult = await gatherRepositoryAnalysisEvidence({
    repoPath,
    sessionId,
    sessionStore,
    eventStore,
    logger,
  });

  if (!evidenceResult.success) {
    const error = evidenceResult.error;
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: {
        error,
        mode: "AGENT_LOOP",
        subMode: "REPOSITORY_ANALYSIS",
      },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }

    return {
      success: false,
      sessionId,
      mode: "AGENT_LOOP",
      summary: error,
      error,
      metadata: toJsonObject({
        subMode: "REPOSITORY_ANALYSIS",
      }),
    };
  }

  const evidence = evidenceResult.evidence;
  await logger.info("analysis", "Repository analysis evidence gathered", {
    listedItems: evidence.listedItems.length,
    readFiles: evidence.readFiles.map((file) => ({
      path: file.path,
      role: file.role,
      endLine: file.endLine,
    })),
  }, sessionId).catch(() => undefined);

  const client = await createOpenAICompatibleClient(repoPath, options);
  const analysisContext = buildRepositoryAnalysisContext({
    userGoal,
    sessionMemory,
    evidence,
  });

  let result = await client.completeText({
    userGoal,
    context: analysisContext,
    mode: "direct",
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "repository_analysis");

  if (result.success && result.text && shouldRepairRepositoryAnalysis(result.text, evidence)) {
    await logger.info("analysis", "Repository analysis answer was too shallow; requesting grounded rewrite", {
      summaryLength: result.text.length,
    }, sessionId).catch(() => undefined);

    const repairContext = [
      analysisContext,
      "",
      "Previous repository analysis answer was too shallow or did not cite enough evidence files.",
      `Previous answer preview:\n${limitText(result.text, 1_200)}`,
      "",
      "Rewrite requirements:",
      "- Mention at least 3 supporting file paths from the loaded evidence.",
      "- Separate confirmed repository facts from any inference.",
      "- Do not omit major loaded modules or currently supported modes that appear in the evidence.",
      "- Prefer a fuller structured analysis over a short summary.",
    ].join("\n");

    const repaired = await client.completeText({
      userGoal,
      context: repairContext,
      mode: "direct",
    });
    await recordLlmUsageFromClient(sessionStore, sessionId, client, "repository_analysis_rewrite");

    if (repaired.success && repaired.text) {
      result = repaired;
    }
  }

  if (!result.success || !result.text) {
    const error = result.error ?? "Repository analysis failed";
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: {
        error,
        mode: "AGENT_LOOP",
        subMode: "REPOSITORY_ANALYSIS",
      },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }

    return {
      success: false,
      sessionId,
      mode: "AGENT_LOOP",
      summary: error,
      error,
      metadata: toJsonObject({
        subMode: "REPOSITORY_ANALYSIS",
        evidenceFiles: evidence.readFiles.map((file) => file.path),
      }),
    };
  }

  process.stdout.write(`[summary]\n${result.text}\n`);

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
      mode: "AGENT_LOOP",
      subMode: "REPOSITORY_ANALYSIS",
      evidenceFiles: evidence.readFiles.map((file) => file.path),
      evidenceFileCount: evidence.readFiles.length,
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "AGENT_LOOP",
      subMode: "REPOSITORY_ANALYSIS",
      evidenceFileCount: evidence.readFiles.length,
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "AGENT_LOOP",
    summary: result.text,
    metadata: toJsonObject({
      subMode: "REPOSITORY_ANALYSIS",
      evidenceFiles: evidence.readFiles.map((file) => file.path),
      evidenceFileCount: evidence.readFiles.length,
      listedItemCount: evidence.listedItems.length,
    }),
  };
}

async function createOpenAICompatibleClient(repoPath: string, options: AgentCliOptions): Promise<OpenAICompatibleClient> {
  const resolvedConfig = resolveLlmConfig(await loadAgentConfig(repoPath), {
    baseUrl: options.baseUrl,
    model: options.model,
  });

  return new OpenAICompatibleClient(resolvedConfig.openai);
}

async function recordLlmUsageFromClient(
  sessionStore: SessionStore,
  sessionId: string,
  client: OpenAICompatibleClient,
  mode: string,
): Promise<void> {
  const metrics = client.drainCallMetrics();
  if (metrics.length === 0) {
    return;
  }

  for (const metric of metrics) {
    await sessionStore.appendRecord(sessionId, {
      type: "LLM_USAGE",
      payload: toJsonObject({
        mode,
        ...(metric.model ? { model: metric.model } : {}),
        ...(metric.finishReason ? { finishReason: metric.finishReason } : {}),
        usageAvailable: metric.usage !== undefined,
        promptTokens: metric.usage?.promptTokens ?? null,
        completionTokens: metric.usage?.completionTokens ?? null,
        totalTokens: metric.usage?.totalTokens ?? null,
        cachedPromptTokens: metric.usage?.cachedPromptTokens ?? null,
        reasoningTokens: metric.usage?.reasoningTokens ?? null,
      }),
    });
  }
}

async function gatherRepositoryAnalysisEvidence(input: {
  repoPath: string;
  sessionId: string;
  sessionStore: SessionStore;
  eventStore: EventStore;
  logger: ReturnType<typeof createRuntimeLogger>;
}): Promise<
  | { success: true; evidence: RepositoryAnalysisEvidence }
  | { success: false; error: string }
> {
  const registry = createDefaultToolRegistry();
  const toolContext: ToolContext = {
    repoPath: input.repoPath,
    sessionId: input.sessionId,
    sessionStore: input.sessionStore,
    eventStore: input.eventStore,
    maxOutputChars: 20_000,
    autoApprove: true,
    nonInteractive: true,
  };

  const rootList = await runRepositoryAnalysisTool(registry, "list_files", {
    path: ".",
    maxDepth: 2,
    maxResults: 220,
  }, toolContext);
  if (!rootList.success || !isListFilesData(rootList.data)) {
    return {
      success: false,
      error: rootList.error?.message ?? "Failed to inspect repository tree",
    };
  }

  let listedItems = [...rootList.data.items];
  for (const directoryPath of findPreferredAnalysisDirectories(listedItems).slice(0, 4)) {
    const nestedList = await runRepositoryAnalysisTool(registry, "list_files", {
      path: directoryPath,
      maxDepth: 4,
      maxResults: 180,
    }, toolContext);
    if (!nestedList.success || !isListFilesData(nestedList.data)) {
      continue;
    }

    listedItems = mergeRepositoryListItems(listedItems, nestedList.data.items);
  }

  const readFiles: RepositoryAnalysisFileEvidence[] = [];
  for (const candidate of selectRepositoryProjectFiles(listedItems)) {
    const file = await readRepositoryAnalysisFile(registry, candidate.path, candidate.role, toolContext);
    if (file) {
      readFiles.push(file);
    }
  }

  for (const sourcePath of selectRepresentativeSourceFiles(listedItems).slice(0, 4)) {
    if (readFiles.some((file) => file.path === sourcePath)) {
      continue;
    }

    const file = await readRepositoryAnalysisFile(registry, sourcePath, "source", toolContext);
    if (file) {
      readFiles.push(file);
    }
  }

  const sourceFileCount = readFiles.filter((file) => file.role === "source").length;
  if (sourceFileCount === 0) {
    await input.logger.warn("analysis", "Repository analysis aborted because no source file could be read", {
      listedItems: listedItems.length,
    }, input.sessionId).catch(() => undefined);
    return {
      success: false,
      error: "Repository analysis requires reading at least one source file, but no representative source file could be loaded.",
    };
  }

  const gitStatusResult = await runRepositoryAnalysisTool(registry, "git_status", {}, toolContext);
  const gitDiffResult = await runRepositoryAnalysisTool(registry, "git_diff", {}, toolContext);
  const gitStatus = gitStatusResult.success && isGitStatusData(gitStatusResult.data)
    ? gitStatusResult.data.status
    : gitStatusResult.error?.message ?? "(git status unavailable)";
  const gitDiff = gitDiffResult.success && isGitDiffData(gitDiffResult.data)
    ? gitDiffResult.data.diff
    : gitDiffResult.error?.message ?? "(git diff unavailable)";

  return {
    success: true,
    evidence: {
      listedItems,
      readFiles,
      gitStatus,
      gitDiff,
    },
  };
}

async function runRepositoryAnalysisTool(
  registry: ToolRegistry,
  toolName: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult<unknown>> {
  process.stdout.write(`[tool] ${toolName}\n`);
  return await registry.execute(toolName, input, context);
}

async function readRepositoryAnalysisFile(
  registry: ToolRegistry,
  filePath: string,
  role: RepositoryAnalysisFileEvidence["role"],
  context: ToolContext,
): Promise<RepositoryAnalysisFileEvidence | undefined> {
  const maxLines = role === "source" ? 220 : 180;
  const result = await runRepositoryAnalysisTool(registry, "read_file", {
    path: filePath,
    startLine: 1,
    maxLines,
  }, context);

  if (!result.success || !isReadFileData(result.data) || result.data.content.trim().length === 0) {
    return undefined;
  }

  return {
    path: result.data.path,
    role,
    startLine: result.data.startLine,
    endLine: result.data.endLine,
    totalLines: result.data.totalLines,
    content: result.data.content,
  };
}

function buildRepositoryAnalysisContext(input: {
  userGoal: string;
  sessionMemory: string;
  evidence: RepositoryAnalysisEvidence;
}): string {
  const projectFiles = input.evidence.readFiles.filter((file) => file.role !== "source");
  const sourceFiles = input.evidence.readFiles.filter((file) => file.role === "source");

  return [
    "Repository analysis instructions:",
    "- Analyze the repository only from the evidence below.",
    "- Do not claim that a module, workflow, mode, command, or capability exists unless the loaded file evidence supports it.",
    "- Mention supporting file paths inline for every major claim.",
    "- If the evidence is insufficient for some point, say that clearly instead of guessing.",
    "- Prefer a fuller structured analysis over a short summary.",
    "- Structure the answer with these sections when possible: 项目定位, 关键模块, 运行方式, 当前状态, 风险/下一步.",
    "",
    "Conversation memory:",
    input.sessionMemory,
    "",
    `User task: ${input.userGoal}`,
    "",
    "Evidence coverage:",
    `- listed repository items: ${String(input.evidence.listedItems.length)}`,
    `- loaded project files: ${projectFiles.length > 0 ? projectFiles.map((file) => file.path).join(", ") : "(none)"}`,
    `- loaded source files: ${sourceFiles.length > 0 ? sourceFiles.map((file) => file.path).join(", ") : "(none)"}`,
    "",
    "Repository tree excerpt:",
    ...input.evidence.listedItems.slice(0, 160).map((item) => `- [${item.type}] ${item.path}`),
    "",
    "Git status:",
    input.evidence.gitStatus || "(clean or unavailable)",
    "",
    "Git diff preview:",
    limitText(input.evidence.gitDiff || "(none)", 2_000),
    "",
    "Loaded file evidence:",
    ...input.evidence.readFiles.flatMap((file) => ["", formatRepositoryAnalysisFileForPrompt(file)]),
  ].join("\n");
}

function formatRepositoryAnalysisFileForPrompt(file: RepositoryAnalysisFileEvidence): string {
  return [
    `File: ${file.path}`,
    `Role: ${file.role}`,
    `Lines: ${String(file.startLine)}-${String(file.endLine)} / ${String(file.totalLines)}`,
    file.content,
  ].join("\n");
}

function shouldRepairRepositoryAnalysis(text: string, evidence: RepositoryAnalysisEvidence): boolean {
  if (text.trim().length < 320) {
    return true;
  }

  return !evidence.readFiles.some((file) => text.includes(file.path));
}

function findPreferredAnalysisDirectories(
  items: Array<{ path: string; type: "file" | "directory" }>,
): string[] {
  const preferred = ["src", "app", "lib", "cmd", "server", "backend", "packages"];
  return preferred.filter((candidate) => items.some((item) => item.type === "directory" && item.path === candidate));
}

function mergeRepositoryListItems(
  left: Array<{ path: string; type: "file" | "directory" }>,
  right: Array<{ path: string; type: "file" | "directory" }>,
): Array<{ path: string; type: "file" | "directory" }> {
  const seen = new Set(left.map((item) => `${item.type}:${item.path}`));
  const merged = [...left];

  for (const item of right) {
    const key = `${item.type}:${item.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function selectRepositoryProjectFiles(
  items: Array<{ path: string; type: "file" | "directory" }>,
): Array<{ path: string; role: RepositoryAnalysisFileEvidence["role"] }> {
  const candidates: Array<{ path: string; role: RepositoryAnalysisFileEvidence["role"] }> = [
    { path: "README.md", role: "readme" },
    { path: "README.txt", role: "readme" },
    { path: "README", role: "readme" },
    { path: "package.json", role: "build" },
    { path: "pnpm-lock.yaml", role: "build" },
    { path: "pom.xml", role: "build" },
    { path: "go.mod", role: "build" },
    { path: "CMakeLists.txt", role: "build" },
    { path: "build.gradle", role: "build" },
    { path: "settings.gradle", role: "build" },
    { path: "tsconfig.json", role: "config" },
  ];

  return candidates.filter((candidate) => items.some((item) => item.type === "file" && item.path === candidate.path));
}

function selectRepresentativeSourceFiles(
  items: Array<{ path: string; type: "file" | "directory" }>,
): string[] {
  return items
    .filter((item) => item.type === "file" && isRepositorySourceFile(item.path))
    .sort((left, right) => {
      const score = scoreRepositorySourceFile(right.path) - scoreRepositorySourceFile(left.path);
      return score !== 0 ? score : left.path.localeCompare(right.path);
    })
    .map((item) => item.path);
}

function isRepositorySourceFile(filePath: string): boolean {
  if (/\/?(?:__tests__|tests?|specs?|fixtures?|dist|build|coverage|docs)\//i.test(filePath)) {
    return false;
  }

  return /\.(?:ts|tsx|js|jsx|mjs|cjs|java|go|py|rb|rs|php|kt|kts|swift|c|cc|cpp|h|hpp)$/i.test(filePath);
}

function scoreRepositorySourceFile(filePath: string): number {
  let score = 0;
  const normalized = filePath.replace(/\\/g, "/");

  if (normalized.startsWith("src/")) {
    score += 40;
  }
  if (/\/?(?:cli|agent|core|app|server|backend|frontend|cmd|lib)\//i.test(normalized)) {
    score += 24;
  }
  if (/(?:AgentLoop|TaskRouter|ToolRegistry|SessionStore|ContextBuilder|PatchManager|CommandRunner|main|app|server|cli|router|controller|service|store|manager|core)/i.test(normalized)) {
    score += 36;
  }
  if (/(?:^|\/)(?:index|main|app|server|cli|bootstrap)\.(?:ts|tsx|js|jsx|mjs|cjs|java|go|py|rb|rs|php|kt|kts|swift|c|cc|cpp)$/i.test(normalized)) {
    score += 48;
  }
  if (/\.d\.ts$/i.test(normalized)) {
    score -= 30;
  }
  if (/\/?(?:test|tests|spec|specs)\//i.test(normalized)) {
    score -= 40;
  }

  score -= Math.min(normalized.split("/").length * 2, 14);
  return score;
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

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");
  const resolvedFollowUpGoal = resolveFollowUpQuestion(userGoal, sessionMemory);

  await sessionStore.appendRecord(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });
  await eventStore.appendEvent(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });

  const localReply = resolveLocalDirectReply(userGoal);
  if (localReply) {
    return await finalizeDirectAnswerSuccess(
      sessionStore,
      eventStore,
      sessionId,
      options,
      localReply,
    );
  }

  const client = await createOpenAICompatibleClient(repoPath, options);
  const directContext = resolvedFollowUpGoal && resolvedFollowUpGoal !== userGoal
    ? [
      sessionMemory,
      "",
      `Original short follow-up: ${userGoal}`,
      `Resolved follow-up question: ${resolvedFollowUpGoal}`,
    ].join("\n")
    : sessionMemory;
  const result = await client.completeText({
    userGoal: resolvedFollowUpGoal ?? userGoal,
    context: directContext,
    mode: "direct",
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "direct");

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

  return await finalizeDirectAnswerSuccess(
    sessionStore,
    eventStore,
    sessionId,
    options,
    result.text,
  );
}

async function runWebAnswerTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const logger = createRuntimeLogger(repoPath);
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

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");
  const resolvedFollowUpGoal = resolveFollowUpQuestion(userGoal, sessionMemory);

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
    userGoal: resolvedFollowUpGoal ?? userGoal,
    sessionMemory,
    client,
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "web_rewrite");
  await logger.info("web", "Web plan prepared", {
    searchQueries: webPlan.searchQueries,
    sourceHints: webPlan.sourceHints,
    needsLiveData: webPlan.needsLiveData,
    plannerError: webPlan.plannerError ?? null,
  }, sessionId).catch(() => undefined);

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
      maxResults: 6,
    }, toolContext);
    searchResults.push({ query, result });
    sources = mergeWebSources(sources, extractWebSources(result, query));
    await logger.info("web", "Web search attempt finished", {
      query,
      success: result.success,
      resultCount: extractWebSources(result, query).length,
      error: result.error?.message ?? null,
    }, sessionId).catch(() => undefined);

    if (sources.length >= 8) {
      break;
    }
  }

  sources = rankWebSources(sources, webPlan.sourceHints, searchQueries).slice(0, 8);

  const fetchCandidates = selectWebSourcesForFetching(sources, webPlan.needsLiveData ? 5 : 4);
  const targetFetchedSources = webPlan.needsLiveData ? 2 : 1;
  let successfulFetches = 0;

  for (const source of fetchCandidates) {
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
      successfulFetches += 1;
    } else if (fetchResult.error) {
      source.fetchError = fetchResult.error.message;
    }

    await logger.info("web", "Source fetch finished", {
      url: source.url,
      success: Boolean(fetchedSource),
      error: fetchResult.error?.message ?? null,
    }, sessionId).catch(() => undefined);

    if (successfulFetches >= targetFetchedSources) {
      break;
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
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "web");

  if (!result.success || !result.text) {
    const error = result.error ?? "Web answer failed";
    await logger.error("web", "Web answer generation failed", {
      searchQueryCount: searchQueries.length,
      sourceCount: sources.length,
      fetchedSourceCount: successfulFetches,
      error,
    }, sessionId).catch(() => undefined);
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
  await logger.info("web", "Web answer generated", {
    searchQueryCount: searchQueries.length,
    sourceCount: sources.length,
    fetchedSourceCount: successfulFetches,
  }, sessionId).catch(() => undefined);

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
    metadata: toJsonObject({
      searchQueryCount: searchQueries.length,
      sourceCount: sources.length,
      fetchedSourceCount: successfulFetches,
      fetchedSources: sources.filter((source) => source.fetch).map((source) => source.url),
      searchProviders: searchResults
        .map((entry) => isWebSearchData(entry.result.data) ? entry.result.data.provider : null)
        .filter((provider): provider is string => typeof provider === "string"),
    }),
  };
}

async function runCodeReviewTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const logger = createRuntimeLogger(repoPath);
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
        mode: "CODE_REVIEW",
      },
    });
  }

  process.stdout.write(`[session] ${sessionId}\n`);

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");

  await sessionStore.appendRecord(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });
  await eventStore.appendEvent(sessionId, {
    type: "USER_MESSAGE",
    payload: { content: userGoal },
  });

  const reviewTargetPath = extractLikelyReviewFilePath(userGoal);
  if (!reviewTargetPath) {
    const message = "Please provide a repository file path to review, for example src/tools/WebSearchTool.ts.";
    await logger.warn("review", "Review target path missing", {
      task: userGoal,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[ask] ${message}\n`);
    process.stdout.write(`${message}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: message },
    });
    await eventStore.appendEvent(sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: message },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "CODE_REVIEW",
      summary: message,
      error: message,
    };
  }

  await logger.info("review", "Review target resolved", {
    reviewTargetPath,
  }, sessionId).catch(() => undefined);

  const loadedFile = await loadReviewFile(repoPath, reviewTargetPath, {
    sessionId,
    sessionStore,
    eventStore,
  });
  if (!loadedFile.success) {
    const error = loadedFile.error ?? "Failed to load review target";
    await logger.error("review", "Review target load failed", {
      reviewTargetPath,
      error,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "CODE_REVIEW" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "CODE_REVIEW",
      summary: error,
      error,
    };
  }

  await logger.info("review", "Review file loaded", {
    file: loadedFile.file.path,
    includedEndLine: loadedFile.file.includedEndLine,
    totalLines: loadedFile.file.totalLines,
    truncated: loadedFile.file.truncated,
  }, sessionId).catch(() => undefined);

  const supplementalFiles = await loadSupplementalReviewFiles(repoPath, loadedFile.file, {
    sessionId,
    sessionStore,
    eventStore,
  });

  await logger.info("review", "Review supplemental files loaded", {
    file: loadedFile.file.path,
    supplementalFileCount: supplementalFiles.length,
    supplementalFiles: supplementalFiles.map((file) => file.path),
  }, sessionId).catch(() => undefined);

  const client = await createOpenAICompatibleClient(repoPath, options);
  const reviewResult = await client.completeReview({
    userGoal,
    context: buildCodeReviewContext({
      userGoal,
      sessionMemory,
      reviewFile: loadedFile.file,
      supplementalFiles,
    }),
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "review_json");

  if (!reviewResult.success || !reviewResult.review) {
    const error = reviewResult.error ?? "Code review failed";
    await logger.error("review", "Review draft generation failed", {
      file: loadedFile.file.path,
      error,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "CODE_REVIEW" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "CODE_REVIEW",
      summary: error,
      error,
    };
  }

  let groundedReview = groundCodeReviewResponse(reviewResult.review, loadedFile.file);
  await logger.info("review", "Review draft grounded", {
    file: loadedFile.file.path,
    groundedFindings: groundedReview.findings.length,
    rejectedByGrounding: groundedReview.rejectedFindings.length,
    overallVerdict: groundedReview.overallVerdict,
  }, sessionId).catch(() => undefined);

  let verificationApplied = false;
  if (groundedReview.findings.length > 0) {
    const verificationResult = await client.verifyReview({
      userGoal,
      context: buildCodeReviewVerificationContext({
        userGoal,
        reviewFile: loadedFile.file,
        supplementalFiles,
        findings: groundedReview.findings,
      }),
    });
    await recordLlmUsageFromClient(sessionStore, sessionId, client, "review_verify_json");

    if (verificationResult.success && verificationResult.verification) {
      verificationApplied = true;
      const findingsBeforeVerification = groundedReview.findings.length;
      groundedReview = applyReviewVerification(groundedReview, verificationResult.verification);
      await logger.info("review", "Review verification applied", {
        file: loadedFile.file.path,
        findingsBeforeVerification,
        finalFindings: groundedReview.findings.length,
        rejectedTotal: groundedReview.rejectedFindings.length,
      }, sessionId).catch(() => undefined);
    } else {
      await logger.warn("review", "Review verification failed", {
        file: loadedFile.file.path,
        error: verificationResult.error ?? null,
      }, sessionId).catch(() => undefined);
    }
  } else {
    await logger.info("review", "Review verification skipped because no grounded findings remained", {
      file: loadedFile.file.path,
    }, sessionId).catch(() => undefined);
  }

  const renderedReview = renderCodeReviewOutput(groundedReview, loadedFile.file, supplementalFiles);
  process.stdout.write(`${renderedReview}\n`);

  await logger.info("review", "Review task finished", {
    file: loadedFile.file.path,
    findings: groundedReview.findings.length,
    rejectedFindings: groundedReview.rejectedFindings.length,
    overallVerdict: groundedReview.overallVerdict,
  }, sessionId).catch(() => undefined);

  const summary = groundedReview.summary;
  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: renderedReview },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: renderedReview },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary,
      success: true,
      mode: "CODE_REVIEW",
      file: loadedFile.file.path,
      findings: groundedReview.findings.length,
      rejectedFindings: groundedReview.rejectedFindings.length,
      overallVerdict: groundedReview.overallVerdict,
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "CODE_REVIEW",
      file: loadedFile.file.path,
      findings: groundedReview.findings.length,
      rejectedFindings: groundedReview.rejectedFindings.length,
      overallVerdict: groundedReview.overallVerdict,
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "CODE_REVIEW",
    summary,
    metadata: toJsonObject({
      reviewFile: loadedFile.file.path,
      includedEndLine: loadedFile.file.includedEndLine,
      totalLines: loadedFile.file.totalLines,
      truncated: loadedFile.file.truncated,
      supplementalFileCount: supplementalFiles.length,
      supplementalFiles: supplementalFiles.map((file) => file.path),
      findings: groundedReview.findings.length,
      rejectedFindings: groundedReview.rejectedFindings.length,
      overallVerdict: groundedReview.overallVerdict,
      verificationApplied,
    }),
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

async function finalizeDirectAnswerSuccess(
  sessionStore: SessionStore,
  eventStore: EventStore,
  sessionId: string,
  options: AgentCliOptions,
  text: string,
): Promise<CliTaskResult> {
  process.stdout.write(`[answer]\n${text}\n`);

  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: text },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: text },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary: text,
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
    summary: text,
  };
}

function resolveLocalDirectReply(userGoal: string): string | undefined {
  const normalized = userGoal
    .trim()
    .replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  if (normalized.length === 0) {
    return undefined;
  }

  if (matchesAnyPhrase(normalized, [
    "没事我按错了",
    "没事按错了",
    "按错了",
    "点错了",
    "不小心点错了",
    "误触了",
    "我按错了",
    "我点错了",
  ])) {
    return "好的，没事，你继续说就行。";
  }

  if (matchesAnyPhrase(normalized, [
    "算了",
    "不用了",
    "先这样",
    "先这样吧",
    "当我没说",
    "没事了",
  ])) {
    return "好，先放这儿，需要我时再叫我。";
  }

  return undefined;
}

function matchesAnyPhrase(value: string, phrases: string[]): boolean {
  return phrases.includes(value);
}

function buildWebAnswerContext(input: {
  userGoal: string;
  webPlan: WebQuestionPlan;
  sessionMemory: string;
  searchQueries: string[];
  searchResults: Array<{ query: string; result: ToolResult<unknown> }>;
  sources: WebAnswerSource[];
}): string {
  const fetchedSourceCount = input.sources.filter((source) => source.fetch).length;
  const failedFetchCount = input.sources.filter((source) => source.fetchError).length;
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
    "Evidence quality:",
    `- search queries attempted: ${String(input.searchQueries.length)}`,
    `- source candidates gathered: ${String(input.sources.length)}`,
    `- fetched sources: ${String(fetchedSourceCount)}`,
    `- fetch failures: ${String(failedFetchCount)}`,
    fetchedSourceCount === 0
      ? "- no fetch_url call produced readable page text; rely only on snippets and be explicit about uncertainty."
      : "- prefer fetched page text over snippets when they conflict.",
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

function rankWebSources(
  sources: WebAnswerSource[],
  sourceHints: string[] = [],
  searchQueries: string[] = [],
): WebAnswerSource[] {
  return [...sources].sort((left, right) => scoreWebSource(right, sourceHints, searchQueries) - scoreWebSource(left, sourceHints, searchQueries));
}

function scoreWebSource(source: WebAnswerSource, sourceHints: string[], searchQueries: string[]): number {
  const host = safeHostname(source.url) ?? "";
  const pathname = safePathname(source.url);
  const value = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
  const terms = buildWebSearchTerms(searchQueries);
  let score = 0;

  if (containsAnyText(value, ["fifa.com", "the-afc.com", "jfa.jp"])) {
    score += 10;
  }
  if (containsAnyText(value, ["espn", "bbc", "reuters", "apnews", "sofascore", "flashscore", "fotmob"])) {
    score += 5;
  }
  if (containsAnyText(host, ["github.com", "typescriptlang.org", "nodejs.org", "developer.mozilla.org", "npmjs.com"])) {
    score += 7;
  }
  if (host.endsWith(".gov") || host.endsWith(".edu")) {
    score += 6;
  }
  if (containsAnyText(value, ["score", "scores", "result", "results", "比分", "赛果", "赛程"])) {
    score += 3;
  }
  if (containsAnyText(value, ["official", "官网", "官方"])) {
    score += 2;
  }
  if (containsAnyText(`${host} ${pathname}`, ["docs", "developer", "support", "release", "releases", "changelog", "news", "blog", "announcement"])) {
    score += 3;
  }
  if (sourceHints.some((hint) => value.includes(hint.toLowerCase()))) {
    score += 2;
  }
  if (hasOfficialSourceHint(sourceHints) && containsAnyText(`${host} ${value}`, ["official", "官网", "官方", "docs", "developer", "support", "release", "changelog", ".gov", ".edu"])) {
    score += 4;
  }
  if (hasLiveScoreHint(sourceHints) && containsAnyText(value, ["sofascore", "flashscore", "fotmob", "espn", "score", "scores", "result", "results", "fixture", "fixtures"])) {
    score += 4;
  }
  if (hasReleaseHint(sourceHints) && containsAnyText(`${host} ${pathname} ${value}`, ["release", "releases", "changelog", "version", "update", "announcement", "blog", "docs"])) {
    score += 3;
  }
  score += Math.min(6, countMatchingTerms(value, terms));
  if (containsAnyText(host, ["reddit.com", "quora.com", "zhihu.com", "tieba.baidu.com", "weibo.com", "x.com", "twitter.com"])) {
    score -= 4;
  }
  if (containsAnyText(value, ["forum", "bbs", "贴吧", "社区讨论"])) {
    score -= 2;
  }
  if (source.fetch) {
    score += 4;
  }

  return score;
}

function selectWebSourcesForFetching(sources: WebAnswerSource[], limit: number): WebAnswerSource[] {
  const selected: WebAnswerSource[] = [];
  const deferred: WebAnswerSource[] = [];
  const seenHosts = new Set<string>();

  for (const source of sources) {
    const host = safeHostname(source.url);
    if (host && !seenHosts.has(host)) {
      seenHosts.add(host);
      selected.push(source);
    } else {
      deferred.push(source);
    }
  }

  return [...selected, ...deferred].slice(0, Math.max(0, limit));
}

function buildWebSearchTerms(searchQueries: string[]): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "what",
    "when",
    "where",
    "which",
    "latest",
    "current",
    "official",
    "site",
    "www",
    "com",
    "org",
    "net",
  ]);

  const tokens = searchQueries
    .flatMap((query) => query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && !stopWords.has(part)));

  return [...new Set(tokens)];
}

function countMatchingTerms(value: string, terms: string[]): number {
  let count = 0;
  for (const term of terms) {
    if (value.includes(term)) {
      count += 1;
    }
  }

  return count;
}

function hasOfficialSourceHint(sourceHints: string[]): boolean {
  return sourceHints.some((hint) => /official|官网|官方/i.test(hint));
}

function hasLiveScoreHint(sourceHints: string[]): boolean {
  return sourceHints.some((hint) => /live score|fixture|results|scores?/i.test(hint));
}

function hasReleaseHint(sourceHints: string[]): boolean {
  return sourceHints.some((hint) => /release|changelog|update|公告|发布/i.test(hint));
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

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function isWebSearchData(value: unknown): value is {
  query: string;
  provider: string;
  results: Array<{ title: string; url: string; snippet: string }>;
} {
  if (!isRecord(value) || typeof value.provider !== "string" || !Array.isArray(value.results)) {
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

function isListFilesData(value: unknown): value is {
  items: Array<{ path: string; type: "file" | "directory" }>;
} {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every((item) => isRecord(item)
      && typeof item.path === "string"
      && (item.type === "file" || item.type === "directory"));
}

function isGitStatusData(value: unknown): value is { status: string } {
  return isRecord(value)
    && typeof value.status === "string";
}

function isReadFileData(value: unknown): value is {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
} {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.startLine === "number"
    && typeof value.endLine === "number"
    && typeof value.totalLines === "number"
    && typeof value.content === "string";
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

async function loadReviewFile(
  repoPath: string,
  reviewTargetPath: string,
  stores: {
    sessionId: string;
    sessionStore: SessionStore;
    eventStore: EventStore;
  },
  options?: {
    maxReviewLines?: number;
    chunkSize?: number;
  },
): Promise<
  | { success: true; file: LoadedReviewFile }
  | { success: false; error: string }
> {
  const registry = createDefaultToolRegistry();
  const toolContext: ToolContext = {
    repoPath,
    sessionId: stores.sessionId,
    sessionStore: stores.sessionStore,
    eventStore: stores.eventStore,
    maxOutputChars: 20_000,
    autoApprove: true,
    nonInteractive: true,
  };

  const chunks: ReviewFileChunk[] = [];
  let startLine = 1;
  let loadedLines = 0;
  const maxReviewLines = options?.maxReviewLines ?? 900;
  const chunkSize = options?.chunkSize ?? 220;

  while (loadedLines < maxReviewLines) {
    process.stdout.write("[tool] read_file\n");
    const result = await registry.execute("read_file", {
      path: reviewTargetPath,
      startLine,
      maxLines: chunkSize,
    }, toolContext);

    if (!result.success || !isReadFileData(result.data)) {
      return {
        success: false,
        error: result.error?.message ?? `Failed to read file for review: ${reviewTargetPath}`,
      };
    }

    chunks.push({
      path: result.data.path,
      startLine: result.data.startLine,
      endLine: result.data.endLine,
      totalLines: result.data.totalLines,
      content: result.data.content,
    });

    const linesInChunk = result.data.content.length > 0 ? result.data.content.split("\n").length : 0;
    loadedLines += linesInChunk;

    if (result.data.endLine >= result.data.totalLines || linesInChunk === 0) {
      break;
    }

    startLine = result.data.endLine + 1;
  }

  return {
    success: true,
    file: buildLoadedReviewFile(chunks),
  };
}

async function loadSupplementalReviewFiles(
  repoPath: string,
  reviewFile: LoadedReviewFile,
  stores: {
    sessionId: string;
    sessionStore: SessionStore;
    eventStore: EventStore;
  },
): Promise<LoadedReviewFile[]> {
  const relatedPaths = await extractRelatedReviewFilePaths(repoPath, reviewFile, 3);
  const files: LoadedReviewFile[] = [];

  for (const relatedPath of relatedPaths) {
    const result = await loadReviewFile(repoPath, relatedPath, stores, {
      maxReviewLines: 180,
      chunkSize: 180,
    });

    if (result.success) {
      files.push(result.file);
    }
  }

  return files;
}

function buildCodeReviewContext(input: {
  userGoal: string;
  sessionMemory: string;
  reviewFile: LoadedReviewFile;
  supplementalFiles: LoadedReviewFile[];
}): string {
  return [
    "Review task:",
    input.userGoal,
    "",
    "Conversation memory:",
    input.sessionMemory,
    "",
    "Runtime context:",
    formatRuntimeContext(),
    "",
    "Instructions:",
    "- Review the primary repository file first, and use supplemental related files only as supporting context.",
    "- Report only findings grounded in the provided code.",
    "- Every finding should quote code from the primary file. Use supplemental files only to support or weaken the reasoning.",
    "- If a finding still needs more surrounding code to be proven, mark it as possible instead of confirmed.",
    "- Use the file path exactly as provided in the file sections.",
    "- Keep the findings array short and high-signal.",
    "",
    "Primary file content:",
    formatReviewFileForPrompt(input.reviewFile),
    "",
    "Supplemental related files:",
    ...(input.supplementalFiles.length > 0
      ? input.supplementalFiles.flatMap((file) => ["", formatReviewFileForPrompt(file)])
      : ["(none)"]),
  ].join("\n");
}

function renderCodeReviewOutput(
  result: GroundedCodeReviewResult,
  file: LoadedReviewFile,
  supplementalFiles: LoadedReviewFile[],
): string {
  const lines = [
    `[review] ${result.summary}`,
    `[review] File: ${file.path} (lines 1-${String(file.includedEndLine)} / ${String(file.totalLines)}${file.truncated ? ", truncated" : ""})`,
  ];

  if (supplementalFiles.length > 0) {
    lines.push(`[review] Supplemental context: ${supplementalFiles.map((item) => item.path).join(", ")}`);
  }

  if (result.findings.length === 0) {
    lines.push("[review] No grounded findings were confirmed in the loaded file content.");
  } else {
    result.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. [${finding.certainty}/${finding.severity}] ${finding.file}:${String(finding.line)} ${finding.title}`);
      lines.push(`Quote: ${finding.codeQuote}`);
      lines.push(`Reason: ${finding.reasoning}`);
      if (finding.suggestedFix) {
        lines.push(`Fix: ${finding.suggestedFix}`);
      }
    });
  }

  if (result.rejectedFindings.length > 0) {
    lines.push(`[review] Filtered ${String(result.rejectedFindings.length)} unsupported finding(s) that were not grounded in the file.`);
  }

  if (result.followUp.length > 0) {
    lines.push(`[review] Follow-up: ${result.followUp.join(" | ")}`);
  }

  return lines.join("\n");
}

function buildCodeReviewVerificationContext(input: {
  userGoal: string;
  reviewFile: LoadedReviewFile;
  supplementalFiles: LoadedReviewFile[];
  findings: GroundedCodeReviewFinding[];
}): string {
  return [
    "Original review request:",
    input.userGoal,
    "",
    "Verification instructions:",
    "- Decide whether each preliminary finding is truly supported by the file content.",
    "- The primary file remains the source of truth for each finding quote; use supplemental files only as surrounding context.",
    "- Drop findings whose reasoning is too speculative for the quoted code.",
    "- Keep certainty=confirmed only when the code directly supports the claim.",
    "",
    "Primary file content:",
    formatReviewFileForPrompt(input.reviewFile),
    "",
    "Supplemental related files:",
    ...(input.supplementalFiles.length > 0
      ? input.supplementalFiles.flatMap((file) => ["", formatReviewFileForPrompt(file)])
      : ["(none)"]),
    "",
    "Preliminary findings JSON:",
    JSON.stringify(input.findings.map((finding, index) => ({
      index,
      severity: finding.severity,
      certainty: finding.certainty,
      file: finding.file,
      line: finding.line,
      title: finding.title,
      codeQuote: finding.codeQuote,
      reasoning: finding.reasoning,
      suggestedFix: finding.suggestedFix,
    })), null, 2),
  ].join("\n");
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
      ...(input.result.metadata ?? {}),
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

function formatResumeSessionLine(index: number, session: SessionOverview): string {
  const number = `${String(index).padStart(2, " ")}.`;
  const status = session.status.padEnd(8, " ");
  const updatedAt = formatLocalMinute(session.updatedAt);
  const label = session.lastUserMessage ? "last" : "title";
  const preview = limitSingleLine(session.lastUserMessage ?? session.title, 72);
  const summary = session.latestSummary ? `\n    summary: ${limitSingleLine(session.latestSummary, 88)}` : "";

  return `${number} ${status} ${updatedAt} ${label}: ${preview}\n    id: ${session.sessionId}${summary}`;
}

function formatInteractiveSessionLine(session: SessionOverview): string {
  const preview = limitSingleLine(session.lastUserMessage ?? session.title, 80);
  const summary = session.latestSummary ? `\n          summary: ${limitSingleLine(session.latestSummary, 96)}` : "";
  return `[session] ${session.sessionId} ${session.status} ${formatLocalMinute(session.updatedAt)} ${preview}${summary}`;
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
  const review = formatReviewChangeMetadata(entry.metadata);
  const web = formatWebChangeMetadata(entry.metadata);
  return `[change] ${entry.timestamp} ${entry.success ? "OK" : "FAIL"} ${entry.mode} session=${entry.sessionId}${files}${stat}${tests}${review}${web} task=${entry.task}`;
}

function formatReviewChangeMetadata(metadata: unknown): string {
  if (!isRecord(metadata) || typeof metadata.reviewFile !== "string") {
    return "";
  }

  const supplementalFileCount = typeof metadata.supplementalFileCount === "number"
    ? metadata.supplementalFileCount
    : undefined;
  const findings = typeof metadata.findings === "number" ? metadata.findings : undefined;
  const rejected = typeof metadata.rejectedFindings === "number" ? metadata.rejectedFindings : undefined;
  const verdict = typeof metadata.overallVerdict === "string" ? metadata.overallVerdict : undefined;
  return [
    ` reviewFile=${metadata.reviewFile}`,
    supplementalFileCount === undefined ? "" : ` related=${String(supplementalFileCount)}`,
    findings === undefined ? "" : ` findings=${String(findings)}`,
    rejected === undefined ? "" : ` rejected=${String(rejected)}`,
    verdict ? ` verdict=${verdict}` : "",
  ].join("");
}

function formatWebChangeMetadata(metadata: unknown): string {
  if (!isRecord(metadata) || !("fetchedSourceCount" in metadata || "sourceCount" in metadata)) {
    return "";
  }

  const sourceCount = typeof metadata.sourceCount === "number" ? metadata.sourceCount : undefined;
  const fetchedSourceCount = typeof metadata.fetchedSourceCount === "number" ? metadata.fetchedSourceCount : undefined;
  return [
    sourceCount === undefined ? "" : ` sources=${String(sourceCount)}`,
    fetchedSourceCount === undefined ? "" : ` fetched=${String(fetchedSourceCount)}`,
  ].join("");
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

function readPayloadNumber(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
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
