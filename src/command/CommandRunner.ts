import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { Options } from "execa";
import {
  EmptyCommandError,
  InvalidWorkingDirectoryError,
} from "../utils/errors.js";
import {
  isPathInside,
  normalizeRepoPath,
  resolveRepoPath,
  truncateText,
} from "../utils/fs.js";
import type { VerificationCommandClassification } from "./CommandClassification.js";

export interface CommandRunnerOptions {
  repoPath: string;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
}

export interface CommandInput {
  executable?: string;
  args?: string[];
  command?: string;
  shell?: boolean;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandRunObserver {
  onOutput?: (event: { stream: "stdout" | "stderr"; chunk: string }) => void;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  verification?: VerificationCommandClassification;
}

const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
]);

const INLINE_CODE_EXECUTABLES = new Set([
  "node",
  "node.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "ruby",
  "ruby.exe",
  "perl",
  "perl.exe",
]);

const INLINE_CODE_FLAGS_BY_EXECUTABLE = new Map<string, Set<string>>([
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["node.exe", new Set(["-e", "--eval", "-p", "--print"])],
  ["python", new Set(["-c"])],
  ["python.exe", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["python3.exe", new Set(["-c"])],
  ["ruby", new Set(["-e"])],
  ["ruby.exe", new Set(["-e"])],
  ["perl", new Set(["-e"])],
  ["perl.exe", new Set(["-e"])],
]);

const EXPLICIT_APPROVAL_EXECUTABLES = new Set([
  "curl", "curl.exe", "dd", "docker", "docker.exe", "kubectl", "kubectl.exe",
  "mv", "mv.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "rm", "rm.exe",
  "rmdir", "rmdir.exe", "rsync", "rsync.exe", "scp", "scp.exe", "shred",
  "ssh", "ssh.exe", "terraform", "terraform.exe", "unlink", "wget", "wget.exe",
]);

const SENSITIVE_ENV_KEY_PATTERN = /(?:api[-_]?key|access[-_]?key|token|secret|password|authorization|cookie|credential)/i;
const UNSAFE_CHILD_ENV_KEY_PATTERN = /^(?:NODE_OPTIONS|NODE_V8_COVERAGE|VITEST.*|JEST_WORKER_ID)$/i;

export class CommandRunner {
  readonly repoPath: string;
  readonly defaultTimeoutMs: number;
  readonly maxOutputChars: number;

  constructor(options: CommandRunnerOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.maxOutputChars = options.maxOutputChars ?? 20_000;
  }

  async resolveCwd(cwd = "."): Promise<string> {
    let resolvedPath: string;

    try {
      resolvedPath = resolveRepoPath(this.repoPath, cwd);
    } catch {
      throw new InvalidWorkingDirectoryError("Working directory is outside repository", { cwd });
    }

    const repoRealPath = await fs.realpath(this.repoPath);
    const cwdRealPath = await fs.realpath(resolvedPath).catch(() => undefined);

    if (!cwdRealPath) {
      throw new InvalidWorkingDirectoryError(`Working directory does not exist: ${cwd}`, { cwd });
    }

    if (!isPathInside(repoRealPath, cwdRealPath)) {
      throw new InvalidWorkingDirectoryError("Working directory is outside repository", { cwd });
    }

    const stat = await fs.stat(cwdRealPath);
    if (!stat.isDirectory()) {
      throw new InvalidWorkingDirectoryError(`Working directory is not a directory: ${cwd}`, { cwd });
    }

    return cwdRealPath;
  }

  async run(input: CommandInput, observer: CommandRunObserver = {}): Promise<CommandResult> {
    const preparedCommand = prepareCommand(input);

    const cwd = await this.resolveCwd(input.cwd);
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();

    try {
      let streamedOutputChars = 0;
      const emitOutput = (stream: "stdout" | "stderr", message: string): void => {
        if (!observer.onOutput || streamedOutputChars >= this.maxOutputChars) return;
        const chunk = `${message}\n`.slice(0, this.maxOutputChars - streamedOutputChars);
        streamedOutputChars += chunk.length;
        observer.onOutput({ stream, chunk });
      };
      const options: Options = {
        cwd,
        timeout: timeoutMs,
        reject: false,
        encoding: "utf8",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfterDelay: 500,
        ...(process.platform === "win32" ? {} : { detached: true }),
        env: sanitizeChildProcessEnv(input.env),
        extendEnv: false,
      };

      let timedOut = false;
      const subprocess = execa(preparedCommand.file, preparedCommand.args, options);
      let observedStdout = "";
      let observedStderr = "";
      const captureLimit = this.maxOutputChars + 1;
      subprocess.stdout?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        observedStdout = `${observedStdout}${text}`.slice(0, captureLimit);
        emitOutput("stdout", text);
      });
      subprocess.stderr?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        observedStderr = `${observedStderr}${text}`.slice(0, captureLimit);
        emitOutput("stderr", text);
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        killSubprocessTree(subprocess.pid);
        subprocess.kill("SIGTERM", new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const result = await subprocess.finally(() => {
        clearTimeout(timeout);
      });

      const output = truncateCommandOutput(
        observedStdout || outputToString(result.stdout),
        observedStderr || outputToString(result.stderr),
        this.maxOutputChars,
      );

      return {
        command: preparedCommand.display,
        cwd,
        exitCode: result.exitCode ?? null,
        stdout: output.stdout,
        stderr: output.stderr,
        durationMs: Date.now() - startedAt,
        success: result.exitCode === 0,
        timedOut: timedOut || readBoolean(result, "timedOut"),
        truncated: output.truncated,
      };
    } catch (error) {
      const details = extractExecaError(error);
      const output = truncateCommandOutput(details.stdout, details.stderr, this.maxOutputChars);

      return {
        command: preparedCommand.display,
        cwd,
        exitCode: details.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        durationMs: Date.now() - startedAt,
        success: false,
        timedOut: details.timedOut,
        truncated: output.truncated,
        error: details.message,
      };
    }
  }
}

export function isHighRiskCommandInput(input: CommandInput): boolean {
  if (input.shell === true) {
    return true;
  }

  const executableName = executableBasename(input.executable ?? "");
  if (SHELL_EXECUTABLES.has(executableName)) {
    return true;
  }

  if (EXPLICIT_APPROVAL_EXECUTABLES.has(executableName)) {
    if (["npm", "npm.cmd", "pnpm", "pnpm.cmd"].includes(executableName)) {
      const subcommand = input.args?.find((arg) => !arg.startsWith("-"))?.toLowerCase();
      return subcommand === "publish" || subcommand === "install" || subcommand === "add"
        || subcommand === "remove" || subcommand === "uninstall" || subcommand === "exec";
    }
    return true;
  }

  if (executableName === "git" || executableName === "git.exe") {
    const subcommand = input.args?.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    return subcommand === "push" || subcommand === "clean" || subcommand === "reset"
      || subcommand === "checkout" || subcommand === "restore" || subcommand === "remote";
  }

  if (!INLINE_CODE_EXECUTABLES.has(executableName)) {
    return false;
  }

  return (input.args ?? []).some((arg) => isInlineCodeFlag(executableName, arg));
}

export function sanitizeChildProcessEnv(overrides: Record<string, string> | undefined): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined
      && !SENSITIVE_ENV_KEY_PATTERN.test(key)
      && !UNSAFE_CHILD_ENV_KEY_PATTERN.test(key)
    ) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    environment[key] = value;
  }
  return environment;
}

function executableBasename(executable: string): string {
  const normalized = executable.trim();
  const posixName = path.posix.basename(normalized);
  const win32Name = path.win32.basename(normalized);
  return (win32Name.length < posixName.length ? win32Name : posixName).toLowerCase();
}

function isInlineCodeFlag(executableName: string, arg: string): boolean {
  const normalizedArg = arg.toLowerCase();
  const flags = INLINE_CODE_FLAGS_BY_EXECUTABLE.get(executableName);
  if (!flags) {
    return false;
  }

  if (flags.has(normalizedArg)) {
    return true;
  }

  for (const flag of flags) {
    if (flag.startsWith("--") && normalizedArg.startsWith(`${flag}=`)) {
      return true;
    }
  }

  if (executableName === "node" || executableName === "node.exe") {
    return /^-[^-].*[ep]/.test(normalizedArg);
  }

  if (executableName === "perl" || executableName === "perl.exe") {
    return /^-[^-].*e/.test(normalizedArg);
  }

  return false;
}

interface PreparedCommand {
  file: string;
  args: string[];
  display: string;
}

function prepareCommand(input: CommandInput): PreparedCommand {
  if (input.shell === true) {
    const command = input.command?.trim() ?? "";
    if (command.length === 0) {
      throw new EmptyCommandError();
    }

    return {
      ...buildShellCommand(command),
      display: command,
    };
  }

  const executable = input.executable?.trim() ?? "";
  if (executable.length === 0 || executable.includes("\0")) {
    throw new EmptyCommandError();
  }

  const args = input.args ?? [];
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new EmptyCommandError();
    }
  }

  return {
    file: executable,
    args,
    display: renderCommand(executable, args),
  };
}

function truncateCommandOutput(
  stdout: string,
  stderr: string,
  maxOutputChars: number,
): { stdout: string; stderr: string; truncated: boolean } {
  const maxChars = Math.max(0, maxOutputChars);
  if (stdout.length + stderr.length <= maxChars) {
    return { stdout, stderr, truncated: false };
  }

  const stdoutResult = truncateText(stdout, maxChars);
  const remainingChars = Math.max(0, maxChars - stdoutResult.text.length);
  const stderrResult = truncateText(stderr, remainingChars);

  return {
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    truncated: true,
  };
}

function extractExecaError(error: unknown): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  message: string;
} {
  if (typeof error === "object" && error !== null) {
    return {
      exitCode: readNumberOrNull(error, "exitCode"),
      stdout: readString(error, "stdout"),
      stderr: readString(error, "stderr"),
      timedOut: readBoolean(error, "timedOut"),
      message: readString(error, "message") || "Command execution failed",
    };
  }

  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    message: String(error),
  };
}

function buildShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  return {
    file: "sh",
    args: ["-c", command],
  };
}

function renderCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(quoteCommandPart).join(" ");
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function killSubprocessTree(pid: number | undefined): void {
  if (!pid || process.platform === "win32") {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process might have already exited between the timer and kill call.
  }
}

function outputToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }

  if (Array.isArray(value)) {
    return value.map((item) => outputToString(item)).join("\n");
  }

  if (value === undefined || value === null) {
    return "";
  }

  return String(value);
}

function readString(source: object, key: string): string {
  if (key in source && typeof source[key as keyof typeof source] === "string") {
    return source[key as keyof typeof source] as string;
  }

  return "";
}

function readBoolean(source: object, key: string): boolean {
  return key in source && source[key as keyof typeof source] === true;
}

function readNumberOrNull(source: object, key: string): number | null {
  if (key in source && typeof source[key as keyof typeof source] === "number") {
    return source[key as keyof typeof source] as number;
  }

  return null;
}
