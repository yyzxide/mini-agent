import { GitManager } from "../git/GitManager.js";
import type { AgentState } from "../agent/AgentState.js";
import type { ToolSpec } from "../llm/LlmClient.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import { SessionStore } from "../session/SessionStore.js";
import { MessageCompressor } from "./MessageCompressor.js";
import { formatRepoState, RepoStateAnalyzer } from "./RepoStateAnalyzer.js";
import { RepoScanner } from "./RepoScanner.js";

export interface ContextBuilderOptions {
  repoPath: string;
  maxChars?: number;
}

export class ContextBuilder {
  private readonly repoPath: string;
  private readonly compressor: MessageCompressor;

  constructor(options: ContextBuilderOptions) {
    this.repoPath = options.repoPath;
    this.compressor = new MessageCompressor({ maxChars: options.maxChars ?? 30_000 });
  }

  async build(state: AgentState, availableTools: ToolSpec[] = []): Promise<string> {
    const scanner = new RepoScanner({ repoPath: this.repoPath });
    const git = new GitManager({ repoPath: this.repoPath });
    const repoStateAnalyzer = new RepoStateAnalyzer({ repoPath: this.repoPath });

    const sessionStore = new SessionStore({ repoPath: this.repoPath });

    const [repoState, isGitRepository, tree, readme, buildFiles, status, diff, sessionMemory] = await Promise.all([
      repoStateAnalyzer.analyze().then(formatRepoState).catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.isGitRepository().catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.getTreeSummary().catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.readReadmeSummary().catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.readBuildFileSummary().catch((error: unknown) => `error: ${errorToText(error)}`),
      git.getStatus().catch((error: unknown) => `error: ${errorToText(error)}`),
      git.getDiff({ maxChars: 8_000 }).then((result) => result.diff).catch((error: unknown) => `error: ${errorToText(error)}`),
      readSessionMemory(sessionStore, state.sessionId, { maxRecords: 18, maxChars: 8_000 })
        .catch((error: unknown) => `error: ${errorToText(error)}`),
    ]);

    const snapshot = state.toSnapshot();
    const context = [
      `User task:\n${state.userGoal}`,
      `Agent step:\n${snapshot.step} / ${snapshot.maxSteps}`,
      `Conversation memory:\n${sessionMemory}`,
      `Repository state summary:\n${repoState}`,
      `Available tools:\n${JSON.stringify(availableTools, null, 2)}`,
      `Git repository:\n${String(isGitRepository)}`,
      `Git status:\n${status || "(clean or unavailable)"}`,
      `Tree summary:\n${tree || "(empty)"}`,
      `README summary:\n${readme}`,
      `Build files:\n${buildFiles}`,
      `Recent decisions:\n${JSON.stringify(snapshot.decisions.slice(-6), null, 2)}`,
      `Recent tool results:\n${JSON.stringify(snapshot.toolResults.slice(-5), null, 2)}`,
      `Recent command results:\n${JSON.stringify(snapshot.commandResults.slice(-3), null, 2)}`,
      `Recent patch results:\n${JSON.stringify(snapshot.patchResults.slice(-3), null, 2)}`,
      `Patch failure summary:\n${summarizePatchFailures(state)}`,
      `Test failure summary:\n${summarizeTestFailures(state)}`,
      `Last error:\n${snapshot.lastError ?? "(none)"}`,
      `Current diff:\n${diff || "(none)"}`,
    ].join("\n\n---\n\n");

    return this.compressor.compress(context);
  }
}

function errorToText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizePatchFailures(state: AgentState): string {
  const failures = state.patchResults
    .filter((result) => !result.result.success)
    .slice(-3)
    .map((result) => result.result.error?.message ?? "Patch failed");

  return failures.length > 0 ? failures.join("\n") : "(none)";
}

function summarizeTestFailures(state: AgentState): string {
  const failures = state.commandResults
    .filter((result) => !result.success && isTestCommand(result.command))
    .slice(-3)
    .map((result) => [
      `command: ${result.command}`,
      `exitCode: ${String(result.exitCode)}`,
      `stderr: ${result.stderr.slice(0, 2000) || "(empty)"}`,
      `stdout: ${result.stdout.slice(0, 1000) || "(empty)"}`,
    ].join("\n"));

  return failures.length > 0 ? failures.join("\n\n") : "(none)";
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
