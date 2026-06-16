#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
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
import { GitManager } from "../git/GitManager.js";
import { OpenAICompatibleClient } from "../llm/OpenAICompatibleClient.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import { SessionStore } from "../session/SessionStore.js";
import type { JsonObject } from "../session/SessionTypes.js";
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

const VERSION = "0.1.0";

interface AgentCliOptions {
  session?: string;
  maxSteps?: number;
  model?: string;
  baseUrl?: string;
  eventStream?: boolean;
  agentLoop?: boolean;
  keepSessionActive?: boolean;
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
        const permissionManager = new PermissionManager();
        const permission = await permissionManager.check({
          level: PermissionLevel.DANGEROUS,
          action: "run_command",
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
          cwd,
          timeoutMs,
        });

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

        writeJson(await registry.execute("apply_patch", { patch, checkBeforeApply: true }, context));
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

        const result = await registry.execute(name, parsedInput.data, toolContext);

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
  process.stdout.write("Type your coding task, or use /exit, /new, /diff, /status, /sessions.\n\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await rl.question("> ")).trim();

      if (answer === "/exit") {
        await stores.sessionStore.updateSessionStatus(currentSessionId, "FINISHED");
        process.stdout.write("Bye.\n");
        return;
      }

      if (answer === "/new") {
        currentSessionId = await createInteractiveSession(stores.sessionStore, stores.eventStore, "Interactive session");
        process.stdout.write(`[session] ${currentSessionId}\n`);
        continue;
      }

      if (answer === "/diff") {
        const diff = await readGitDiff(repoPath);
        process.stdout.write(diff.length > 0 ? diff : "[diff] No changes.\n");
        continue;
      }

      if (answer === "/status") {
        const status = await readGitStatus(repoPath);
        process.stdout.write(status.length > 0 ? status : "[status] Clean working tree.\n");
        continue;
      }

      if (answer === "/sessions") {
        const { sessionStore } = createStores(repoPath);
        const sessions = await sessionStore.listSessions();
        if (sessions.length === 0) {
          process.stdout.write("[sessions] No sessions yet.\n");
        } else {
          for (const session of sessions) {
            process.stdout.write(`[session] ${session.sessionId} ${session.status} ${session.title}\n`);
          }
        }
        continue;
      }

      if (answer.length === 0) {
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
): Promise<{ success: boolean }> {
  process.stdout.write(`[task] ${userGoal}\n`);

  const route = routeTask(userGoal);
  if (route.intent === "DIRECT_ANSWER" && options.agentLoop !== true) {
    return await runDirectAnswerTask(repoPath, userGoal, options);
  }

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

  return await loop.run({
    userGoal,
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    autoApprove: true,
    nonInteractive: options.nonInteractive === true,
    keepSessionActive: options.keepSessionActive === true,
  });
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
): Promise<{ success: boolean }> {
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
  const result = await client.completeText({ userGoal, context: sessionMemory });

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
    return { success: false };
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

  return { success: true };
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

async function readGitStatus(repoPath: string): Promise<string> {
  const result = await createDefaultToolRegistry().execute("git_status", {}, { repoPath });
  if (result.success && isGitStatusData(result.data)) {
    return result.data.status;
  }

  return `[git] ${result.error?.message ?? "Unable to read git status"}\n`;
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

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
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

function isGitStatusData(value: unknown): value is { status: string } {
  return typeof value === "object"
    && value !== null
    && "status" in value
    && typeof value.status === "string";
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
