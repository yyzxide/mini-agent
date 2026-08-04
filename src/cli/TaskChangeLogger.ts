import { TaskDiffStore } from "../diff/TaskDiffStore.js";
import { GitManager } from "../git/GitManager.js";
import { EventStore } from "../session/EventStore.js";
import {
  TaskChangeLogStore,
  type TaskChangeLogEntry,
  type TaskChangeTestResult,
} from "../session/TaskChangeLogStore.js";
import type { EventRecord } from "../session/SessionTypes.js";
import type { CliTaskResult } from "./CliTaskRuntime.js";

export interface GitSnapshot {
  changedFiles: string[];
  diffStat: string | null;
}

export async function readGitSnapshot(repoPath: string): Promise<GitSnapshot> {
  const git = new GitManager({ repoPath });
  if (!(await git.isGitRepository().catch(() => false))) {
    return { changedFiles: [], diffStat: null };
  }

  const diffSummary = await git.generateDiffSummary().catch(() => null);
  return {
    changedFiles: diffSummary?.changedFiles ?? [],
    diffStat: diffSummary?.stat || null,
  };
}

export async function appendTaskChangeLog(
  repoPath: string,
  input: {
    userGoal: string;
    result: CliTaskResult;
    beforeSnapshot: GitSnapshot;
  },
): Promise<TaskChangeLogEntry | undefined> {
  if (!input.result.sessionId) return undefined;

  const tests = await readTaskTests(repoPath, input.result.sessionId);
  const artifactId = typeof input.result.metadata?.diffArtifactId === "string"
    ? input.result.metadata.diffArtifactId
    : undefined;
  const taskArtifact = artifactId
    ? await new TaskDiffStore(repoPath).read(input.result.sessionId, artifactId).catch(() => undefined)
    : undefined;
  const taskChangedFiles = taskArtifact
    ? taskArtifact.files.map((file) => file.path)
    : [];
  const afterSnapshot = await readGitSnapshot(repoPath);
  const diffStat = taskArtifact
    ? `${String(taskArtifact.fileCount)} files changed, ${String(taskArtifact.additions)} insertions(+), ${String(taskArtifact.deletions)} deletions(-)`
    : afterSnapshot.diffStat;

  return await new TaskChangeLogStore({ repoPath }).append({
    sessionId: input.result.sessionId,
    task: input.userGoal,
    mode: input.result.mode,
    success: input.result.success,
    summary: limitText(input.result.summary, 2_000),
    beforeChangedFiles: input.beforeSnapshot.changedFiles,
    currentChangedFiles: afterSnapshot.changedFiles,
    taskChangedFiles,
    diffStat,
    tests,
    ...(input.result.error ? { error: input.result.error } : {}),
    metadata: {
      beforeDiffStat: input.beforeSnapshot.diffStat,
      afterDiffStat: afterSnapshot.diffStat,
      ...(input.result.metadata ?? {}),
    },
  });
}

async function readTaskTests(repoPath: string, sessionId: string): Promise<TaskChangeTestResult[]> {
  const events = await new EventStore({ repoPath }).readEvents(sessionId).catch(() => []);
  return events
    .filter(isTestEventRecord)
    .slice(-10)
    .map((event): TaskChangeTestResult => ({
      type: event.type === "TEST_PASSED" ? "TEST_PASSED" : "TEST_FAILED",
      command: typeof event.payload.command === "string" ? event.payload.command : "",
      exitCode: typeof event.payload.exitCode === "number" ? event.payload.exitCode : null,
    }));
}

function isTestEventRecord(
  event: EventRecord,
): event is EventRecord & { type: "TEST_PASSED" | "TEST_FAILED" } {
  return event.type === "TEST_PASSED" || event.type === "TEST_FAILED";
}

function limitText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}
