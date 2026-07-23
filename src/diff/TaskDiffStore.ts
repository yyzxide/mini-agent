import fs from "node:fs/promises";
import { ensureDir, readJsonFile, resolveMiniAgentPath, writeJsonFileAtomic } from "../utils/fs.js";
import type { TaskDiffArtifact } from "./TaskDiffTypes.js";

export class TaskDiffStore {
  constructor(private readonly repoPath: string) {}

  async save(artifact: TaskDiffArtifact): Promise<void> {
    const directory = this.sessionDirectory(artifact.sessionId);
    await ensureDir(directory, 0o700);
    await writeJsonFileAtomic(this.artifactPath(artifact.sessionId, artifact.artifactId), artifact);
  }

  async read(sessionId: string, artifactId: string): Promise<TaskDiffArtifact | undefined> {
    this.assertId(sessionId);
    this.assertId(artifactId);
    return await readJsonFile<TaskDiffArtifact | undefined>(this.artifactPath(sessionId, artifactId), undefined);
  }

  async latest(sessionId: string): Promise<TaskDiffArtifact | undefined> {
    this.assertId(sessionId);
    const directory = this.sessionDirectory(sessionId);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    });
    const artifacts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<TaskDiffArtifact | undefined>(resolveMiniAgentPath(
        this.repoPath,
        "diffs",
        sessionId,
        entry.name,
      ), undefined)));
    return artifacts
      .filter((artifact): artifact is TaskDiffArtifact => artifact !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  private sessionDirectory(sessionId: string): string {
    this.assertId(sessionId);
    return resolveMiniAgentPath(this.repoPath, "diffs", sessionId);
  }

  private artifactPath(sessionId: string, artifactId: string): string {
    this.assertId(sessionId);
    this.assertId(artifactId);
    return resolveMiniAgentPath(this.repoPath, "diffs", sessionId, `${artifactId}.json`);
  }

  private assertId(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
      throw new Error(`Invalid diff artifact identifier: ${value}`);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
