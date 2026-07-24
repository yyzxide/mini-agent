import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { PatchManager } from "../patch/PatchManager.js";
import { normalizeRepoPath } from "../utils/fs.js";

export interface SubAgentWorktreeOptions {
  repoPath: string;
  dependencyPatches?: string[];
}

export interface SubAgentWorktreeSnapshot {
  repoPath: string;
  baselineFingerprint: string;
  baselineCommit: string;
  kind: "GIT_WORKTREE" | "ISOLATED_COPY";
}

/**
 * Creates a disposable writable repository for one child task. A Git-backed
 * workspace starts from HEAD, overlays the parent's tracked and untracked
 * working-tree state, and commits that overlay as the child's private
 * baseline. Non-Git test fixtures use an isolated copy initialized as Git.
 */
export class SubAgentWorktree {
  private readonly parentRepoPath: string;
  private readonly rootPath: string;
  private disposed = false;
  readonly snapshot: SubAgentWorktreeSnapshot;

  private constructor(
    parentRepoPath: string,
    rootPath: string,
    snapshot: SubAgentWorktreeSnapshot,
  ) {
    this.parentRepoPath = parentRepoPath;
    this.rootPath = rootPath;
    this.snapshot = snapshot;
  }

  static async create(options: SubAgentWorktreeOptions): Promise<SubAgentWorktree> {
    const parentRepoPath = normalizeRepoPath(options.repoPath);
    const baselineFingerprint = await fingerprintWorkingTree(parentRepoPath);
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-child-"));
    const workspacePath = path.join(rootPath, "worktree");
    const gitHead = await readGitHead(parentRepoPath);
    let kind: SubAgentWorktreeSnapshot["kind"];

    try {
      if (gitHead) {
        await runGit(
          parentRepoPath,
          ["worktree", "add", "--detach", workspacePath, gitHead],
          "Unable to create child Git worktree",
        );
        kind = "GIT_WORKTREE";
        await overlayParentWorkingTree(parentRepoPath, workspacePath);
      } else {
        await copyRepository(parentRepoPath, workspacePath);
        await runGit(workspacePath, ["init", "--quiet"], "Unable to initialize isolated child repository");
        kind = "ISOLATED_COPY";
      }

      await linkDependencyDirectory(parentRepoPath, workspacePath, "node_modules");
      await commitBaseline(workspacePath);
      const baselineCommit = await requireGitHead(workspacePath);

      for (const patch of options.dependencyPatches ?? []) {
        const result = await new PatchManager({ repoPath: workspacePath }).applyPatch({
          patch,
          checkBeforeApply: true,
        });
        if (!result.success) {
          throw new Error(`Unable to materialize dependency patch in child worktree: ${result.error ?? result.checkResult.stderr ?? "unknown conflict"}`);
        }
      }

      return new SubAgentWorktree(parentRepoPath, rootPath, {
        repoPath: workspacePath,
        baselineFingerprint,
        baselineCommit,
        kind,
      });
    } catch (error) {
      await cleanupWorktree(parentRepoPath, workspacePath, rootPath, gitHead !== undefined);
      throw error;
    }
  }

  async createPatch(): Promise<string> {
    await runGit(
      this.snapshot.repoPath,
      ["add", "--intent-to-add", "--", "."],
      "Unable to discover new child files",
    );
    const result = await execa("git", ["diff", "--binary", this.snapshot.baselineCommit, "--"], {
      cwd: this.snapshot.repoPath,
      reject: false,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to generate child patch: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await cleanupWorktree(
      this.parentRepoPath,
      this.snapshot.repoPath,
      this.rootPath,
      this.snapshot.kind === "GIT_WORKTREE",
    );
  }
}

export async function fingerprintWorkingTree(repoPath: string): Promise<string> {
  const normalized = normalizeRepoPath(repoPath);
  const hash = createHash("sha256");
  const head = await readGitHead(normalized);
  hash.update(`head:${head ?? "non-git"}\0`);

  if (!head) {
    await hashDirectory(normalized, normalized, hash);
    return hash.digest("hex");
  }

  const diff = await execa("git", ["diff", "--binary", "HEAD", "--"], {
    cwd: normalized,
    reject: false,
    encoding: "buffer",
    stripFinalNewline: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.exitCode !== 0) {
    throw new Error(`Unable to fingerprint tracked working-tree state: ${bufferText(diff.stderr)}`);
  }
  hash.update(Buffer.from(diff.stdout as Uint8Array));

  for (const relativePath of await listUntrackedFiles(normalized)) {
    hash.update(`untracked:${relativePath}\0`);
    const absolutePath = path.join(normalized, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${await fs.readlink(absolutePath)}\0`);
    } else if (stat.isFile()) {
      hash.update(await fs.readFile(absolutePath));
    }
  }
  return hash.digest("hex");
}

async function overlayParentWorkingTree(parentRepoPath: string, workspacePath: string): Promise<void> {
  const diff = await execa("git", ["diff", "--binary", "HEAD", "--"], {
    cwd: parentRepoPath,
    reject: false,
    encoding: "buffer",
    stripFinalNewline: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.exitCode !== 0) {
    throw new Error(`Unable to capture parent working-tree changes: ${bufferText(diff.stderr)}`);
  }
  const patch = Buffer.from(diff.stdout as Uint8Array);
  if (patch.length > 0) {
    const applied = await execa("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
      cwd: workspacePath,
      reject: false,
      encoding: "utf8",
      input: patch,
    });
    if (applied.exitCode !== 0) {
      throw new Error(`Unable to overlay parent tracked changes: ${applied.stderr || applied.stdout}`);
    }
  }

  for (const relativePath of await listUntrackedFiles(parentRepoPath)) {
    if (isInternalPath(relativePath)) continue;
    const source = path.join(parentRepoPath, relativePath);
    const destination = path.join(workspacePath, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    });
  }
}

async function copyRepository(parentRepoPath: string, workspacePath: string): Promise<void> {
  await fs.cp(parentRepoPath, workspacePath, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const relative = path.relative(parentRepoPath, source);
      return relative === "" || !isInternalPath(relative);
    },
  });
}

async function commitBaseline(workspacePath: string): Promise<void> {
  await runGit(workspacePath, ["add", "-A"], "Unable to stage child baseline");
  const status = await execa("git", ["status", "--porcelain"], {
    cwd: workspacePath,
    reject: false,
    encoding: "utf8",
  });
  if (status.exitCode !== 0) {
    throw new Error(`Unable to inspect child baseline: ${status.stderr || status.stdout}`);
  }
  if (!status.stdout.trim()) return;
  await runGit(workspacePath, [
    "-c", "user.name=Mini Agent",
    "-c", "user.email=mini-agent@localhost",
    "commit", "--quiet", "--no-gpg-sign", "-m", "mini-agent child baseline",
  ], "Unable to commit child baseline");
}

async function cleanupWorktree(
  parentRepoPath: string,
  workspacePath: string,
  rootPath: string,
  gitWorktree: boolean,
): Promise<void> {
  if (gitWorktree) {
    await execa("git", ["worktree", "remove", "--force", workspacePath], {
      cwd: parentRepoPath,
      reject: false,
      encoding: "utf8",
    }).catch(() => undefined);
  }
  await fs.rm(rootPath, { recursive: true, force: true });
}

async function listUntrackedFiles(repoPath: string): Promise<string[]> {
  const result = await execa("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoPath,
    reject: false,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to list untracked files: ${bufferText(result.stderr)}`);
  }
  return Buffer.from(result.stdout as Uint8Array)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

async function readGitHead(repoPath: string): Promise<string | undefined> {
  const result = await execa("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repoPath,
    reject: false,
    encoding: "utf8",
  });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function requireGitHead(repoPath: string): Promise<string> {
  const head = await readGitHead(repoPath);
  if (!head) throw new Error("Child worktree baseline commit is unavailable.");
  return head;
}

async function runGit(repoPath: string, args: string[], message: string): Promise<void> {
  const result = await execa("git", args, {
    cwd: repoPath,
    reject: false,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${message}: ${result.stderr || result.stdout}`.trim());
  }
}

async function linkDependencyDirectory(
  parentRepoPath: string,
  workspacePath: string,
  name: string,
): Promise<void> {
  const source = path.join(parentRepoPath, name);
  const destination = path.join(workspacePath, name);
  const [sourceStat, destinationStat] = await Promise.all([
    fs.stat(source).catch(() => undefined),
    fs.lstat(destination).catch(() => undefined),
  ]);
  if (!sourceStat?.isDirectory() || destinationStat) return;
  await fs.symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
}

async function hashDirectory(rootPath: string, currentPath: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath);
    if (isInternalPath(relativePath)) continue;
    hash.update(`${entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file"}:${relativePath}\0`);
    if (entry.isDirectory()) {
      await hashDirectory(rootPath, absolutePath, hash);
    } else if (entry.isSymbolicLink()) {
      hash.update(await fs.readlink(absolutePath));
    } else if (entry.isFile()) {
      hash.update(await fs.readFile(absolutePath));
    }
  }
}

function isInternalPath(relativePath: string): boolean {
  const first = relativePath.split(/[\\/]/, 1)[0];
  return first === ".git" || first === ".mini-agent" || first === "node_modules";
}

function bufferText(value: unknown): string {
  return value instanceof Uint8Array
    ? Buffer.from(value).toString("utf8")
    : String(value ?? "");
}
