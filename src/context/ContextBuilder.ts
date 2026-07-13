import { GitManager } from "../git/GitManager.js";
import { isTestCommand } from "../command/CommandClassification.js";
import type { AgentState } from "../agent/AgentState.js";
import type { ToolSpec } from "../llm/LlmClient.js";
import { MemoryContextService } from "../memory/MemoryContextService.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import { SessionStore } from "../session/SessionStore.js";
import { formatRepoState, RepoStateAnalyzer } from "./RepoStateAnalyzer.js";
import { FilePlacementAdvisor, formatFilePlacementAdvice } from "./FilePlacementAdvisor.js";
import { RepoScanner } from "./RepoScanner.js";
import { truncateText } from "../utils/fs.js";
import { formatRuntimeContext } from "./RuntimeContext.js";
import { formatSkillsForContext, SkillStore } from "../skills/SkillStore.js";

export interface ContextBuilderOptions {
  repoPath: string;
  maxChars?: number;
  budgets?: Partial<ContextSectionBudgets>;
}

export interface ContextSectionBudgets {
  task: number;
  memory: number;
  longTermMemory: number;
  skills: number;
  repoState: number;
  tools: number;
  runtime: number;
  git: number;
  repositoryStructure: number;
  projectDocs: number;
  filePlacement: number;
  recentResults: number;
  diagnostics: number;
  diff: number;
}

export class ContextBuilder {
  private readonly repoPath: string;
  private readonly maxChars: number;
  private readonly budgets: ContextSectionBudgets;

  constructor(options: ContextBuilderOptions) {
    this.repoPath = options.repoPath;
    this.maxChars = options.maxChars ?? 30_000;
    this.budgets = {
      ...createDefaultBudgets(this.maxChars),
      ...options.budgets,
    };
  }

  async build(state: AgentState, availableTools: ToolSpec[] = []): Promise<string> {
    const scanner = new RepoScanner({ repoPath: this.repoPath });
    const git = new GitManager({ repoPath: this.repoPath });
    const repoStateAnalyzer = new RepoStateAnalyzer({ repoPath: this.repoPath });
    const filePlacementAdvisor = new FilePlacementAdvisor({ repoPath: this.repoPath });

    const sessionStore = new SessionStore({ repoPath: this.repoPath });
    const memoryContextService = new MemoryContextService({ repoPath: this.repoPath });
    const skillStore = new SkillStore({ repoPath: this.repoPath });

    const [
      repoStateDetails,
      isGitRepository,
      tree,
      readme,
      buildFiles,
      status,
      diff,
      sessionMemory,
      longTermMemory,
      selectedSkills,
    ] = await Promise.all([
      repoStateAnalyzer.analyze().catch((error: unknown) => ({ error: errorToText(error) })),
      scanner.isGitRepository().catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.getTreeSummary().catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.readReadmeSummary().catch((error: unknown) => `error: ${errorToText(error)}`),
      scanner.readBuildFileSummary().catch((error: unknown) => `error: ${errorToText(error)}`),
      git.getStatus().catch((error: unknown) => `error: ${errorToText(error)}`),
      git.getDiff({ maxChars: 8_000 }).then((result) => result.diff).catch((error: unknown) => `error: ${errorToText(error)}`),
      readSessionMemory(sessionStore, state.sessionId, { maxRecords: 80, maxChars: 12_000 })
        .catch((error: unknown) => `error: ${errorToText(error)}`),
      memoryContextService.build({ query: state.userGoal, limit: 5, sessionId: state.sessionId })
        .catch((error: unknown) => `error: ${errorToText(error)}`),
      skillStore.select(state.userGoal, 3)
        .then(formatSkillsForContext)
        .catch((error: unknown) => `error: ${errorToText(error)}`),
    ]);
    const repoState = hasErrorRecord(repoStateDetails)
      ? `error: ${repoStateDetails.error}`
      : formatRepoState(repoStateDetails);
    const filePlacement = hasErrorRecord(repoStateDetails)
      ? "error: repository state unavailable for file-placement advice"
      : await filePlacementAdvisor.advise(state.userGoal, repoStateDetails)
        .then(formatFilePlacementAdvice)
        .catch((error: unknown) => `error: ${errorToText(error)}`);

    const snapshot = state.toSnapshot();
    const sections: ContextSection[] = [
      {
        title: "Task and step",
        budget: this.budgets.task,
        required: true,
        content: [
          `User task:\n${state.userGoal}`,
          `Agent step:\n${snapshot.step} / ${snapshot.maxSteps}`,
        ].join("\n\n"),
      },
      { title: "Conversation memory", budget: this.budgets.memory, content: sessionMemory },
      {
        title: "Long-term retrieved memory",
        budget: this.budgets.longTermMemory,
        content: [
          "Relevant memories retrieved from previous local sessions. Treat them as hints; prefer current files, current tool output, and current user instructions when they conflict.",
          longTermMemory,
        ].join("\n\n"),
      },
      {
        title: "Selected skills",
        budget: this.budgets.skills,
        content: selectedSkills,
      },
      { title: "Runtime context", budget: this.budgets.runtime, content: formatRuntimeContext() },
      { title: "Repository state summary", budget: this.budgets.repoState, content: repoState },
      { title: "Available tools", budget: this.budgets.tools, content: JSON.stringify(availableTools, null, 2) },
      {
        title: "Git state",
        budget: this.budgets.git,
        content: [
          `Git repository:\n${String(isGitRepository)}`,
          `Git status:\n${status || "(clean or unavailable)"}`,
        ].join("\n\n"),
      },
      { title: "Tree summary", budget: this.budgets.repositoryStructure, content: tree || "(empty)" },
      {
        title: "Project docs and build files",
        budget: this.budgets.projectDocs,
        content: [
          `README summary:\n${readme}`,
          `Build files:\n${buildFiles}`,
        ].join("\n\n"),
      },
      {
        title: "New file placement guidance",
        budget: this.budgets.filePlacement,
        content: filePlacement,
      },
      {
        title: "Recent decisions and results",
        budget: this.budgets.recentResults,
        content: [
          `Recent decisions:\n${JSON.stringify(snapshot.decisions.slice(-6), null, 2)}`,
          `Recent tool results:\n${JSON.stringify(snapshot.toolResults.slice(-5), null, 2)}`,
          `Recent command results:\n${JSON.stringify(snapshot.commandResults.slice(-3), null, 2)}`,
          `Recent patch results:\n${JSON.stringify(snapshot.patchResults.slice(-3), null, 2)}`,
        ].join("\n\n"),
      },
      {
        title: "Diagnostics",
        budget: this.budgets.diagnostics,
        required: true,
        content: [
          `Last error:\n${snapshot.lastError ?? "(none)"}`,
          `Patch failure summary:\n${summarizePatchFailures(state)}`,
          `Test failure summary:\n${summarizeTestFailures(state)}`,
        ].join("\n\n"),
      },
      { title: "Current diff", budget: this.budgets.diff, required: true, content: diff || "(none)" },
    ];

    return formatBudgetedSections(sections, this.maxChars);
  }
}

interface ContextSection {
  title: string;
  budget: number;
  content: string;
  required?: boolean;
}

function createDefaultBudgets(maxChars: number): ContextSectionBudgets {
  return {
    task: Math.floor(maxChars * 0.08),
    memory: Math.floor(maxChars * 0.09),
    longTermMemory: Math.floor(maxChars * 0.08),
    skills: Math.floor(maxChars * 0.08),
    repoState: Math.floor(maxChars * 0.08),
    tools: Math.floor(maxChars * 0.08),
    runtime: Math.floor(maxChars * 0.05),
    git: Math.floor(maxChars * 0.05),
    repositoryStructure: Math.floor(maxChars * 0.07),
    projectDocs: Math.floor(maxChars * 0.07),
    filePlacement: Math.floor(maxChars * 0.07),
    recentResults: Math.floor(maxChars * 0.07),
    diagnostics: Math.floor(maxChars * 0.07),
    diff: Math.floor(maxChars * 0.08),
  };
}

function formatBudgetedSections(sections: ContextSection[], maxChars: number): string {
  const parts: string[] = [];
  let remaining = Math.max(0, maxChars);

  for (const [index, section] of sections.entries()) {
    const separator = parts.length === 0 ? "" : "\n\n---\n\n";
    const header = `${section.title}:\n`;
    const overhead = separator.length + header.length;
    const reservedForRequired = estimateSectionsLength(sections.slice(index + 1).filter((item) => item.required));
    const available = section.required ? remaining : remaining - reservedForRequired;
    if (available <= overhead) {
      if (section.required && remaining <= overhead) {
        break;
      }
      continue;
    }

    const contentBudget = Math.max(0, Math.min(section.budget, available - overhead));
    const formatted = formatBudgetedSectionContent(section.content, contentBudget);
    parts.push(`${separator}${header}${formatted}`);
    remaining -= overhead + formatted.length;
  }

  return parts.join("");
}

function estimateSectionsLength(sections: ContextSection[]): number {
  return sections.reduce((total, section) => {
    return total + "\n\n---\n\n".length + `${section.title}:\n`.length + section.budget;
  }, 0);
}

function formatBudgetedSectionContent(content: string, maxChars: number): string {
  const normalized = content.length > 0 ? content : "(empty)";
  const truncated = truncateText(normalized, maxChars);
  if (!truncated.truncated) {
    return truncated.text;
  }

  const marker = "\n[section truncated]";
  if (maxChars <= marker.length) {
    return truncated.text;
  }

  const textBudget = Math.max(0, maxChars - marker.length);
  return `${normalized.slice(0, textBudget)}${marker}`;
}

function errorToText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorRecord(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as { error?: unknown }).error === "string";
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
