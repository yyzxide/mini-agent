import { readSessionMemory } from "../session/SessionMemory.js";
import type { EventStore } from "../session/EventStore.js";
import type { SessionStore } from "../session/SessionStore.js";
import { ToolRegistry, createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext, ToolResult } from "../tools/Tool.js";
import { toJsonObject } from "../utils/json.js";
import { createRuntimeLogger } from "../utils/logger.js";
import { appendLongTermMemoryContext, MemoryContextService } from "../memory/MemoryContextService.js";
import { appendSkillContext, SkillContextService } from "../skills/SkillContextService.js";
import { createOpenAICompatibleClient, openTaskSession, recordTaskUserMessage, recordLlmUsageFromClient } from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";

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

export async function runRepositoryAnalysisTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const logger = createRuntimeLogger(repoPath);
  const { sessionId, sessionStore, eventStore } = await openTaskSession({
    repoPath,
    userGoal,
    options,
    mode: "AGENT_LOOP",
    sessionPayload: { subMode: "REPOSITORY_ANALYSIS" },
  });

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");
  const longTermMemory = await new MemoryContextService({ repoPath }).build({ query: userGoal, sessionId })
    .catch(() => "(none)");
  const analysisMemory = appendLongTermMemoryContext(sessionMemory, longTermMemory);
  const skillContext = await new SkillContextService({ repoPath }).build(userGoal).catch(() => "(none selected)");
  const analysisContextMemory = appendSkillContext(analysisMemory, skillContext);

  await recordTaskUserMessage({ sessionId, sessionStore, eventStore, content: userGoal });

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
    sessionMemory: analysisContextMemory,
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

function isGitDiffData(value: unknown): value is { diff: string } {
  return isRecord(value) && typeof value.diff === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}
