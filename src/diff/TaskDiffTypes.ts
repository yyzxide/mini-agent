export type TaskDiffChangeType = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "COPIED" | "UNKNOWN";

export interface WorkingTreeSnapshot {
  treeHash: string;
  capturedAt: string;
}

export interface TaskDiffFile {
  path: string;
  oldPath?: string;
  changeType: TaskDiffChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TaskDiffArtifact {
  version: 1;
  artifactId: string;
  sessionId: string;
  createdAt: string;
  beforeTree: string;
  afterTree: string;
  fileCount: number;
  additions: number;
  deletions: number;
  files: TaskDiffFile[];
  unifiedDiff: string;
  truncated: boolean;
}
