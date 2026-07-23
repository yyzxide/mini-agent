#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { execa } from "execa";
import {
  looksLikeCodeContinuationFollowUp,
  routeTask,
  shouldPreserveAgentLoopIntent,
} from "../agent/TaskRouter.js";
import type { TaskRoute } from "../agent/TaskRouter.js";
import { buildAgentTaskContract } from "../agent/TaskContractBuilder.js";
import { findLatestAgentCheckpoint, recoverLatestAgentCheckpoint } from "../agent/AgentCheckpoint.js";
import { CommandRunner } from "../command/CommandRunner.js";
import type { CommandResult } from "../command/CommandRunner.js";
import { classifyVerificationCommandInput } from "../command/CommandClassification.js";
import {
  initAgentConfig,
  loadAgentConfig,
  redactAgentConfig,
  resolveLlmConfig,
} from "../config/AgentConfig.js";
import { MessageCompressor } from "../context/MessageCompressor.js";
import { formatRepoState, RepoStateAnalyzer } from "../context/RepoStateAnalyzer.js";
import { TaskDiffStore } from "../diff/TaskDiffStore.js";
import { promptTaskDiffAction, renderChangesCard, showTaskDiffViewer } from "../diff/TerminalDiffViewer.js";
import { GitManager } from "../git/GitManager.js";
import { formatLongTermMemoryResults, LongTermMemoryStore } from "../memory/LongTermMemoryStore.js";
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
import type { ToolContext } from "../tools/Tool.js";
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
import { isShortFollowUpQuestion } from "../agent/FollowUpQuestionResolver.js";
import { SkillStore } from "../skills/SkillStore.js";
import { createStores } from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";
import { runAgentLoopTask } from "./AgentLoopTask.js";
import { registerMcpCommands } from "./McpCommands.js";
import { registerRagCommands } from "./RagCommands.js";
import { registerToolCommands } from "./ToolCommands.js";
import { registerBenchCommands } from "./BenchCommands.js";

const VERSION = "0.1.0";
const INTERACTIVE_RESUME_LIST_LIMIT = 10;
const INTERACTIVE_SLASH_COMMANDS = [
  { command: "/help", usage: "/help", description: "Show this help." },
  { command: "/new", usage: "/new", description: "Start a new conversation session." },
  { command: "/review", usage: "/review <file>", description: "Run a focused code review for one file." },
  { command: "/plan", usage: "/plan [task|off|status]", description: "Enter read-only plan mode." },
  { command: "/execute", usage: "/execute [notes]", description: "Execute the latest approved plan." },
  { command: "/resume", usage: "/resume [n|id]", description: "Pick from recent sessions, or switch by number/id." },
  { command: "/pause", usage: "/pause", description: "Pause this session and exit; resume it later." },
  { command: "/session", usage: "/session", description: "Show current session metadata." },
  { command: "/summary", usage: "/summary", description: "Show a compact summary of the current session." },
  { command: "/sessions", usage: "/sessions", description: "List local sessions." },
  { command: "/history", usage: "/history [n]", description: "Show recent session records." },
  { command: "/events", usage: "/events [n]", description: "Show recent session events." },
  { command: "/logs", usage: "/logs [n]", description: "Show recent runtime logs." },
  { command: "/changes", usage: "/changes [n]", description: "Show recent task change-log entries." },
  { command: "/compact", usage: "/compact", description: "Write a compact memory record for this session." },
  { command: "/memory", usage: "/memory <query>", description: "Search local long-term memory." },
  { command: "/remember", usage: "/remember <text>", description: "Save an explicit long-term memory." },
  { command: "/forget", usage: "/forget <id>", description: "Delete one long-term memory." },
  { command: "/skills", usage: "/skills [name]", description: "List skills or show one skill." },
  { command: "/status", usage: "/status", description: "Show current agent/session status." },
  { command: "/repo", usage: "/repo", description: "Show repository state summary." },
  { command: "/diff", usage: "/diff", description: "Open the latest task changes." },
  { command: "/clear", usage: "/clear", description: "Clear the terminal." },
  { command: "/exit", usage: "/exit", description: "Finish this session and exit." },
] as const;

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
  operatingMode: "EXECUTE" | "PLAN";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  eventCount: number;
  lastMode?: TaskChangeMode;
  lastUserMessage?: string;
  latestSummary?: string;
  checkpoint: {
    runId: string;
    status: string;
    totalSteps: number;
    recoverable: boolean;
    repositoryChanged: boolean;
    verificationAfterLatestChange: boolean;
    latestVerification?: { command: string; success: boolean };
    inFlightAction?: string;
  } | null;
  llm: {
    configuredModel: string | null;
    configuredBaseUrl: string | null;
    configuredMaxTokens: number | null;
    calls: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    cachedPromptTokens: number | null;
    cacheWriteTokens: number | null;
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
    .option("--verbose", "Show tool inputs, context compaction, cache, and token details")
    .option("--trace", "Show complete redacted runtime decisions and context allocation traces")
    .option("--agent-loop", "Use the iterative decision protocol for direct-answer tasks")
    .option("--agents <number>", "Enable controlled read-only sub-agents (2-3; 1 disables)", parseAgentCount)
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
    .command("plan")
    .description("Create a read-only implementation plan")
    .argument("<task...>", "Task to plan")
    .option("--session <sessionId>", "Session id used for the plan")
    .option("--max-steps <number>", "Maximum planning steps", parsePositiveInteger)
    .option("--model <model>", "Override MINI_AGENT_MODEL for OpenAI-compatible clients")
    .option("--base-url <url>", "Override MINI_AGENT_BASE_URL for OpenAI-compatible clients")
    .option("--event-stream", "Print structured MINI_AGENT_EVENT lines")
    .option("--verbose", "Show detailed planning telemetry")
    .option("--trace", "Show complete redacted planning traces")
    .option("--agents <number>", "Enable controlled read-only sub-agents (2-3; 1 disables)", parseAgentCount)
    .action(async (taskParts: string[], options: AgentCliOptions) => {
      const task = taskParts.join(" ").trim();
      if (!task) throw new Error("Plan task cannot be empty.");
      const result = await runAgentTask(process.cwd(), task, {
        ...options,
        agentLoop: true,
        operatingMode: "PLAN",
        nonInteractive: true,
      });
      if (!result.success) process.exitCode = 1;
    });

  program
    .command("review")
    .description("Run a file-focused code review")
    .argument("<filePath>", "Repository-relative file path to review")
    .option("--session <sessionId>", "Session id used for the task")
    .option("--model <model>", "Override MINI_AGENT_MODEL for OpenAI-compatible clients")
    .option("--base-url <url>", "Override MINI_AGENT_BASE_URL for OpenAI-compatible clients")
    .option("--event-stream", "Print structured MINI_AGENT_EVENT lines for local integrations")
    .option("--verbose", "Show detailed review telemetry")
    .option("--trace", "Show complete redacted review traces")
    .action(async (filePath: string, options: AgentCliOptions) => {
      const trimmedPath = filePath.trim();
      if (trimmedPath.length === 0) {
        throw new Error("File path cannot be empty.");
      }

      const result = await runAgentTask(process.cwd(), trimmedPath, options);
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
    .description("Open a task diff, or print the current repository diff")
    .option("--session <sessionId>", "Open the latest task diff from a session")
    .option("--artifact <artifactId>", "Open a specific task diff artifact; requires --session")
    .action(async (options: { session?: string; artifact?: string }) => {
      if (options.session) {
        const store = new TaskDiffStore(process.cwd());
        const artifact = options.artifact
          ? await store.read(options.session, options.artifact)
          : await store.latest(options.session);
        if (!artifact) {
          process.stdout.write("[diff] No task changes found for that session.\n");
          return;
        }
        await showTaskDiffViewer(artifact);
        return;
      }
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

  const memoryCommand = program
    .command("memory")
    .description("Manage local long-term memory");

  memoryCommand
    .command("index")
    .description("Index one session, or all sessions when no session id is provided")
    .argument("[sessionId]", "Session id to index")
    .action(async (sessionId?: string) => {
      await runJsonAction(async () => {
        const repoPath = process.cwd();
        const { sessionStore } = createStores(repoPath);
        const memoryStore = new LongTermMemoryStore({ repoPath });
        const targets = sessionId
          ? [sessionId]
          : (await sessionStore.listSessions()).map((session) => session.sessionId);
        const results = [];

        for (const targetSessionId of targets) {
          results.push(await memoryStore.indexSession(sessionStore, targetSessionId));
        }

        writeJson({
          indexedSessions: results.length,
          indexedEntries: results.reduce((total, result) => total + result.indexed, 0),
          results,
        });
      });
    });

  const skillCommand = program
    .command("skill")
    .description("Discover and validate repository or local agent skills");

  skillCommand
    .command("list")
    .description("List valid skills")
    .action(async () => {
      await runJsonAction(async () => {
        writeJson(await new SkillStore({ repoPath: process.cwd() }).list());
      });
    });

  skillCommand
    .command("show")
    .description("Show one skill")
    .argument("<name>", "Skill name")
    .action(async (name: string) => {
      await runJsonAction(async () => {
        const skill = await new SkillStore({ repoPath: process.cwd() }).get(name);
        if (!skill) {
          throw new Error(`Skill not found: ${name}`);
        }
        writeJson(skill);
      });
    });

  skillCommand
    .command("validate")
    .description("Validate all discovered skills")
    .action(async () => {
      await runJsonAction(async () => {
        const results = await new SkillStore({ repoPath: process.cwd() }).validateAll();
        writeJson({
          valid: results.filter((result) => result.valid).length,
          invalid: results.filter((result) => !result.valid).length,
          results,
        });
      });
    });

  skillCommand
    .command("init")
    .description("Create a local skill template under .mini-agent/skills")
    .argument("<name>", "Skill name")
    .requiredOption("--description <description>", "When this skill should be used")
    .action(async (name: string, options: { description: string }) => {
      await runJsonAction(async () => {
        writeJson(await new SkillStore({ repoPath: process.cwd() }).create(name, options.description));
      });
    });

  memoryCommand
    .command("search")
    .description("Search local long-term memory")
    .argument("<query...>", "Search query")
    .option("--limit <number>", "Maximum memories to return", parsePositiveInteger, 5)
    .action(async (queryParts: string[], options: { limit: number }) => {
      await runJsonAction(async () => {
        const memoryStore = new LongTermMemoryStore({ repoPath: process.cwd() });
        writeJson(await memoryStore.search(queryParts.join(" "), { limit: options.limit }));
      });
    });

  memoryCommand
    .command("list")
    .description("List latest indexed long-term memories")
    .option("--limit <number>", "Maximum memories to return", parsePositiveInteger, 20)
    .action(async (options: { limit: number }) => {
      await runJsonAction(async () => {
        const memoryStore = new LongTermMemoryStore({ repoPath: process.cwd() });
        writeJson((await memoryStore.list(options.limit)).map(formatMemoryEntryForOutput));
      });
    });

  memoryCommand
    .command("remember")
    .description("Save an explicit long-term memory")
    .argument("<text...>", "Memory text")
    .option("--title <title>", "Short memory title")
    .option("--confidence <number>", "Confidence between 0 and 1", parseProbability)
    .option("--ttl-days <number>", "Expire this memory after a positive number of days", parsePositiveNumber)
    .action(async (textParts: string[], options: { title?: string; confidence?: number; ttlDays?: number }) => {
      await runJsonAction(async () => {
        writeJson(await new LongTermMemoryStore({ repoPath: process.cwd() }).remember({
          text: textParts.join(" "),
          ...(options.title ? { title: options.title } : {}),
          ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
          ...(options.ttlDays === undefined ? {} : { ttlDays: options.ttlDays }),
        }));
      });
    });

  memoryCommand
    .command("forget")
    .description("Delete one long-term memory by id")
    .argument("<id>", "Memory id")
    .action(async (id: string) => {
      await runJsonAction(async () => {
        const removed = await new LongTermMemoryStore({ repoPath: process.cwd() }).remove(id);
        writeJson({ id, removed });
      });
    });

  memoryCommand
    .command("stats")
    .description("Show long-term memory statistics")
    .action(async () => {
      await runJsonAction(async () => {
        writeJson(await new LongTermMemoryStore({ repoPath: process.cwd() }).stats());
      });
    });

  memoryCommand
    .command("migrate")
    .description("Upgrade memory schema and rebuild embeddings with the configured provider")
    .action(async () => {
      await runJsonAction(async () => {
        writeJson(await new LongTermMemoryStore({ repoPath: process.cwd() }).migrate());
      });
    });

  memoryCommand
    .command("clear")
    .description("Delete all local long-term memories")
    .option("--yes", "Confirm destructive deletion")
    .action(async (options: { yes?: boolean }) => {
      await runJsonAction(async () => {
        if (options.yes !== true) {
          throw new Error("memory clear requires --yes");
        }
        writeJson({ removed: await new LongTermMemoryStore({ repoPath: process.cwd() }).clear() });
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
        result.verification = classifyVerificationCommandInput({ command, shell: true });

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

          if (result.verification.level === "TEST") {
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

  registerToolCommands(program);
  registerMcpCommands(program);
  registerRagCommands(program);
  registerBenchCommands(program);

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
  process.stdout.write("Type your coding task, or use /help, /review, /pause, /exit, /new, /resume, /status, /repo, /sessions.\n\n");

  let rl = createInteractiveReadline();

  try {
    while (true) {
      const meta = await stores.sessionStore.getSessionMeta(currentSessionId);
      const answer = (await rl.question(meta.operatingMode === "PLAN" ? "plan> " : "> ")).trim();

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
        if (slashResult.diffArtifactId) {
          const artifact = await new TaskDiffStore(repoPath).read(currentSessionId, slashResult.diffArtifactId);
          if (artifact) {
            rl.close();
            await showTaskDiffViewer(artifact);
            rl = createInteractiveReadline();
          }
        }
        if (slashResult.exit) {
          return;
        }
        continue;
      }

      const result = await runAgentTask(repoPath, answer, {
        session: currentSessionId,
        nonInteractive: false,
        keepSessionActive: true,
        ...(meta.operatingMode === "PLAN" ? { agentLoop: true, operatingMode: "PLAN" as const } : {}),
      }, async (message) => await rl.question(message));
      const diffArtifactId = result.metadata ? readPayloadString(result.metadata, "diffArtifactId") : undefined;
      if (diffArtifactId && result.sessionId && process.stdin.isTTY && process.stdout.isTTY) {
        const artifact = await new TaskDiffStore(repoPath).read(result.sessionId, diffArtifactId);
        if (artifact) {
          rl.close();
          await promptTaskDiffAction(artifact);
          rl = createInteractiveReadline();
        }
      }
    }
  } finally {
    rl.close();
  }
}

function createInteractiveReadline(): ReturnType<typeof createInterface> {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completeInteractiveInput,
  });
}

async function handleInteractiveSlashCommand(input: {
  command: string;
  repoPath: string;
  stores: { sessionStore: SessionStore; eventStore: EventStore };
  currentSessionId: string;
  prompt?: (message: string) => Promise<string>;
}): Promise<{ sessionId: string; exit: boolean; diffArtifactId?: string }> {
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

    case "/pause":
      await input.stores.sessionStore.updateSessionStatus(input.currentSessionId, "PAUSED");
      await input.stores.eventStore.appendEvent(input.currentSessionId, {
        type: "SESSION_PAUSED",
        payload: {
          mode: "interactive",
        },
      });
      await logger.info("cli", "Interactive session paused", {}, input.currentSessionId).catch(() => undefined);
      process.stdout.write(`[pause] Session paused: ${input.currentSessionId}\n`);
      process.stdout.write(`Resume with: mini-agent resume ${input.currentSessionId}\n`);
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

      await runAgentTask(input.repoPath, reviewTarget, {
        session: input.currentSessionId,
        keepSessionActive: true,
      }, input.prompt);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/plan": {
      const argument = args.join(" ").trim();
      if (argument === "status") {
        const meta = await input.stores.sessionStore.getSessionMeta(input.currentSessionId);
        process.stdout.write(`[plan] Mode: ${meta.operatingMode ?? "EXECUTE"}\n`);
        return { sessionId: input.currentSessionId, exit: false };
      }
      if (argument === "off") {
        await input.stores.sessionStore.updateOperatingMode(input.currentSessionId, "EXECUTE");
        await input.stores.eventStore.appendEvent(input.currentSessionId, {
          type: "PLAN_MODE_EXITED",
          payload: { mode: "EXECUTE" },
        });
        process.stdout.write("[plan] Plan mode disabled.\n");
        return { sessionId: input.currentSessionId, exit: false };
      }

      await input.stores.sessionStore.updateOperatingMode(input.currentSessionId, "PLAN");
      await input.stores.eventStore.appendEvent(input.currentSessionId, {
        type: "PLAN_MODE_ENTERED",
        payload: { mode: "PLAN" },
      });
      process.stdout.write("[plan] Read-only plan mode enabled. Use /execute to run the latest plan or /plan off to exit.\n");
      if (argument) {
        await runAgentTask(input.repoPath, argument, {
          session: input.currentSessionId,
          agentLoop: true,
          operatingMode: "PLAN",
          keepSessionActive: true,
          nonInteractive: false,
        }, input.prompt);
      }
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/execute": {
      const latestPlan = await findLatestSuccessfulPlan(input.stores.sessionStore, input.currentSessionId);
      if (!latestPlan) {
        process.stdout.write("[execute] No successful plan found. Create one with /plan <task>.\n");
        return { sessionId: input.currentSessionId, exit: false };
      }

      const notes = args.join(" ").trim();
      await input.stores.sessionStore.updateOperatingMode(input.currentSessionId, "EXECUTE");
      await input.stores.eventStore.appendEvent(input.currentSessionId, {
        type: "PLAN_EXECUTION_STARTED",
        payload: { goal: latestPlan.goal },
      });
      const executionGoal = [
        `Execute the approved plan for this goal: ${latestPlan.goal}`,
        "",
        "Approved plan:",
        latestPlan.summary,
        notes ? `\nAdditional user notes:\n${notes}` : "",
        "",
        "Re-check the current repository state before each change. The plan is guidance, not permission to bypass normal tools, validation, or safety checks.",
      ].join("\n");
      await runAgentTask(input.repoPath, executionGoal, {
        session: input.currentSessionId,
        agentLoop: true,
        operatingMode: "EXECUTE",
        keepSessionActive: true,
        nonInteractive: false,
      }, input.prompt);
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
      const artifact = await new TaskDiffStore(input.repoPath).latest(input.currentSessionId);
      if (artifact) {
        return { sessionId: input.currentSessionId, exit: false, diffArtifactId: artifact.artifactId };
      }
      const diff = await readGitDiff(input.repoPath);
      process.stdout.write(diff.length > 0 ? diff : "[diff] No task changes.\n");
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

    case "/memory": {
      const query = args.join(" ").trim();
      const memoryStore = new LongTermMemoryStore({ repoPath: input.repoPath });
      if (query.length === 0) {
        const entries = (await memoryStore.list(10)).map(formatMemoryEntryForOutput);
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return { sessionId: input.currentSessionId, exit: false };
      }

      const results = await memoryStore.search(query, { limit: 5 });
      process.stdout.write(`[memory]\n${formatLongTermMemoryResults(results)}\n`);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/remember": {
      const text = args.join(" ").trim();
      if (!text) {
        process.stdout.write("[memory] Usage: /remember <text>\n");
        return { sessionId: input.currentSessionId, exit: false };
      }
      const entry = await new LongTermMemoryStore({ repoPath: input.repoPath }).remember({
        text,
        sessionId: input.currentSessionId,
      });
      process.stdout.write(`[memory] Remembered ${entry.id}\n`);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/forget": {
      const id = args[0]?.trim();
      if (!id) {
        process.stdout.write("[memory] Usage: /forget <id>\n");
        return { sessionId: input.currentSessionId, exit: false };
      }
      const removed = await new LongTermMemoryStore({ repoPath: input.repoPath }).remove(id);
      process.stdout.write(`[memory] ${removed ? "Forgot" : "Not found"}: ${id}\n`);
      return { sessionId: input.currentSessionId, exit: false };
    }

    case "/skills": {
      const skillStore = new SkillStore({ repoPath: input.repoPath });
      const name = args[0]?.trim();
      if (name) {
        const skill = await skillStore.get(name);
        process.stdout.write(skill ? `${JSON.stringify(skill, null, 2)}\n` : `[skills] Skill not found: ${name}\n`);
      } else {
        const skills = await skillStore.list();
        process.stdout.write(skills.length > 0
          ? `[skills]\n${skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`).join("\n")}\n`
          : "[skills] No valid skills discovered.\n");
      }
      return { sessionId: input.currentSessionId, exit: false };
    }

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

async function findLatestSuccessfulPlan(
  sessionStore: SessionStore,
  sessionId: string,
): Promise<{ goal: string; summary: string } | undefined> {
  const records = await sessionStore.readRecords(sessionId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "TASK_SUMMARY" || record.payload.mode !== "PLAN" || record.payload.success !== true) {
      continue;
    }
    const goal = typeof record.payload.goal === "string" ? record.payload.goal.trim() : "";
    const summary = typeof record.payload.summary === "string" ? record.payload.summary.trim() : "";
    if (goal && summary) {
      return { goal, summary };
    }
  }
  return undefined;
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
    if (mode === "DIRECT_ANSWER" || mode === "WEB_ANSWER" || mode === "CODE_REVIEW" || mode === "AGENT_LOOP" || mode === "PLAN") {
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
    await new LongTermMemoryStore({ repoPath: initialMeta.repoPath }).indexSession(sessionStore, sessionId);
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
  const latestCheckpoint = findLatestAgentCheckpoint(records);
  const recoverableCheckpoint = recoverLatestAgentCheckpoint(records);

  return {
    sessionId: meta.sessionId,
    repoPath: meta.repoPath,
    title: meta.title,
    sessionStatus: meta.status,
    operatingMode: meta.operatingMode ?? "EXECUTE",
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    eventCount: meta.eventCount,
    ...(lastMode ? { lastMode } : {}),
    ...(lastUserMessage ? { lastUserMessage } : {}),
    ...(latestSummary ? { latestSummary } : {}),
    checkpoint: latestCheckpoint ? {
      runId: latestCheckpoint.runId,
      status: latestCheckpoint.status,
      totalSteps: latestCheckpoint.totalSteps,
      recoverable: recoverableCheckpoint?.runId === latestCheckpoint.runId,
      repositoryChanged: latestCheckpoint.effects.successfulPatch,
      verificationAfterLatestChange: latestCheckpoint.effects.verificationAfterPatch === true,
      ...(latestCheckpoint.effects.latestVerification
        ? {
          latestVerification: {
            command: latestCheckpoint.effects.latestVerification.command,
            success: latestCheckpoint.effects.latestVerification.success,
          },
        }
        : {}),
      ...(latestCheckpoint.inFlightAction ? { inFlightAction: latestCheckpoint.inFlightAction } : {}),
    } : null,
    llm: {
      configuredModel: resolvedConfig?.openai.model ?? lastRecordedModel ?? null,
      configuredBaseUrl: resolvedConfig?.openai.baseUrl ?? null,
      configuredMaxTokens: resolvedConfig?.openai.maxTokens ?? null,
      calls: usageSummary.calls,
      promptTokens: usageSummary.promptTokens,
      completionTokens: usageSummary.completionTokens,
      totalTokens: usageSummary.totalTokens,
      cachedPromptTokens: usageSummary.cachedPromptTokens,
      cacheWriteTokens: usageSummary.cacheWriteTokens,
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
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    usageAvailable: boolean;
  } {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedPromptTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let hasPromptTokens = false;
  let hasCompletionTokens = false;
  let hasTotalTokens = false;
  let hasCachedPromptTokens = false;
  let hasCacheWriteTokens = false;
  let hasReasoningTokens = false;
  let usageAvailable = false;
  let calls = 0;

  for (const record of records) {
    calls += readPayloadNumber(record.payload, "llmCalls") ?? 1;
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

    const cacheWrite = readPayloadNumber(record.payload, "cacheWriteTokens");
    if (cacheWrite !== undefined) {
      cacheWriteTokens += cacheWrite;
      hasCacheWriteTokens = true;
    }

    const reasoning = readPayloadNumber(record.payload, "reasoningTokens");
    if (reasoning !== undefined) {
      reasoningTokens += reasoning;
      hasReasoningTokens = true;
    }
  }

  return {
    calls,
    promptTokens: hasPromptTokens ? promptTokens : null,
    completionTokens: hasCompletionTokens ? completionTokens : null,
    totalTokens: hasTotalTokens ? totalTokens : null,
    cachedPromptTokens: hasCachedPromptTokens ? cachedPromptTokens : null,
    cacheWriteTokens: hasCacheWriteTokens ? cacheWriteTokens : null,
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
    `cache_write=${status.llm.cacheWriteTokens ?? "unavailable"}`,
    `reasoning=${status.llm.reasoningTokens ?? "unavailable"}`,
  ].join(", ");

  return [
    "Agent status:",
    `- session: ${status.sessionId}`,
    `- title: ${status.title}`,
    `- repo: ${status.repoPath}`,
    `- status: ${status.sessionStatus}`,
    `- operating mode: ${status.operatingMode}`,
    `- created: ${formatLocalMinute(status.createdAt)}`,
    `- updated: ${formatLocalMinute(status.updatedAt)}`,
    `- messages: ${String(status.messageCount)}`,
    `- events: ${String(status.eventCount)}`,
    status.lastMode ? `- last mode: ${status.lastMode}` : undefined,
    status.lastUserMessage ? `- last user message: ${limitSingleLine(status.lastUserMessage, 120)}` : undefined,
    status.latestSummary ? `- latest summary: ${limitSingleLine(status.latestSummary, 120)}` : undefined,
    status.checkpoint
      ? `- checkpoint: ${status.checkpoint.status}, run=${status.checkpoint.runId}, total steps=${String(status.checkpoint.totalSteps)}, recoverable=${String(status.checkpoint.recoverable)}`
      : "- checkpoint: (none)",
    status.checkpoint?.inFlightAction ? `- checkpoint in-flight action: ${status.checkpoint.inFlightAction}` : undefined,
    status.checkpoint
      ? `- completion evidence: repository changed=${String(status.checkpoint.repositoryChanged)}, verification after latest change=${String(status.checkpoint.verificationAfterLatestChange)}`
      : undefined,
    status.checkpoint?.latestVerification
      ? `- latest verification: ${status.checkpoint.latestVerification.success ? "PASS" : "FAIL"} ${status.checkpoint.latestVerification.command}`
      : undefined,
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
  await sessionStore.updateSessionStatus(sessionId, "ACTIVE");
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
  const multiAgentConfigured = route.intent === "AGENT_LOOP"
    && await loadAgentConfig(repoPath).then((config) => config.multiAgent?.mode === "auto").catch(() => false);
  const taskContract = buildAgentTaskContract({
    userGoal,
    route,
    ...(options.operatingMode ? { operatingMode: options.operatingMode } : {}),
    forceIterative: options.operatingMode !== "PLAN" && options.agentLoop === true,
    multiAgentEnabled: (options.agents ?? 1) > 1 || multiAgentConfigured,
  });
  const mode: TaskChangeMode = taskContract.resultMode;
  const logger = createRuntimeLogger(repoPath);
  const beforeSnapshot = await readGitSnapshot(repoPath);
  let taskResult: CliTaskResult;

  await logger.info("cli", "Task started", {
    task: userGoal,
    mode,
    reason: route.reason,
    requestedSessionId: options.session ?? null,
    multiAgentRequested: (options.agents ?? 1) > 1 || multiAgentConfigured,
  }).catch(() => undefined);

  try {
    taskResult = await runAgentLoopTask(repoPath, userGoal, options, prompt, taskContract);
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
    const taskSessionId = taskResult.sessionId;
    const diffArtifactId = typeof taskResult.metadata?.diffArtifactId === "string"
      ? taskResult.metadata.diffArtifactId
      : undefined;
    const artifact = diffArtifactId
      ? await new TaskDiffStore(repoPath).read(taskSessionId, diffArtifactId).catch(() => undefined)
      : undefined;
    if (artifact) {
      process.stdout.write(`${renderChangesCard(
        artifact,
        process.stdout.isTTY === true,
        options.keepSessionActive === true && process.stdin.isTTY === true && process.stdout.isTTY === true,
      )}\n`);
    }

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

    await indexLongTermMemoryForSession(repoPath, taskSessionId, logger).catch(async (error: unknown) => {
      await logger.warn("memory", "Failed to index long-term memory", {
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

async function indexLongTermMemoryForSession(
  repoPath: string,
  sessionId: string,
  logger: ReturnType<typeof createRuntimeLogger>,
): Promise<void> {
  const sessionStore = new SessionStore({ repoPath });
  const memoryStore = new LongTermMemoryStore({ repoPath });
  const result = await memoryStore.indexSession(sessionStore, sessionId);
  await logger.info("memory", "Long-term memory indexed", {
    sessionId,
    indexed: result.indexed,
    total: result.total,
  }, sessionId).catch(() => undefined);
}

async function resolveTaskRoute(
  repoPath: string,
  userGoal: string,
  sessionId: string | undefined,
): Promise<TaskRoute> {
  const baseRoute = routeTask(userGoal);
  const activatedSkill = await new SkillStore({ repoPath }).matchExactActivation(userGoal).catch(() => undefined);
  if (activatedSkill) {
    return {
      intent: "DIRECT_ANSWER",
      reason: `Input exactly activates repository skill ${activatedSkill.name}.`,
    };
  }

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

  if (baseRoute.intent === "AGENT_LOOP" && shouldPreserveAgentLoopIntent(userGoal)) {
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

  if (
    baseRoute.intent === "DIRECT_ANSWER"
    && lastMode === "AGENT_LOOP"
    && looksLikeCodeContinuationFollowUp(userGoal)
  ) {
    return {
      intent: "AGENT_LOOP",
      reason: "Short coding follow-up inherited the previous repository-editing mode from the active session.",
    };
  }

  return baseRoute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
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

  const tests = await readTaskTests(repoPath, input.result.sessionId);
  const artifactId = typeof input.result.metadata?.diffArtifactId === "string"
    ? input.result.metadata.diffArtifactId
    : undefined;
  const taskArtifact = artifactId
    ? await new TaskDiffStore(repoPath).read(input.result.sessionId, artifactId).catch(() => undefined)
    : undefined;
  const changedFiles = taskArtifact
    ? taskArtifact.files.map((file) => file.path)
    : [];
  const diffStat = taskArtifact
    ? `${String(taskArtifact.fileCount)} files changed, ${String(taskArtifact.additions)} insertions(+), ${String(taskArtifact.deletions)} deletions(-)`
    : "";
  return await new TaskChangeLogStore({ repoPath }).append({
    sessionId: input.result.sessionId,
    task: input.userGoal,
    mode: input.result.mode,
    success: input.result.success,
    summary: limitText(input.result.summary, 2_000),
    beforeChangedFiles: [],
    currentChangedFiles: changedFiles,
    diffStat,
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

function parseAgentCount(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 3) {
    throw new Error(`Expected an agent count between 1 and 3, got: ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected a positive number, got: ${value}`);
  return parsed;
}

function parseProbability(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`Expected a number between 0 and 1, got: ${value}`);
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

function formatMemoryEntryForOutput(entry: Awaited<ReturnType<LongTermMemoryStore["list"]>>[number]): Omit<typeof entry, "vector"> {
  const { vector: _vector, ...visible } = entry;
  return visible;
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
