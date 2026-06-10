import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ListFilesTool } from "../../src/tools/ListFilesTool.js";
import { ReadFileTool } from "../../src/tools/ReadFileTool.js";
import {
  createDefaultToolRegistry,
  ToolRegistry,
} from "../../src/tools/ToolRegistry.js";
import type { ToolResult } from "../../src/tools/Tool.js";

const execFileAsync = promisify(execFile);

interface ListFilesData {
  items: Array<{ path: string; type: "file" | "directory" }>;
}

interface ReadFileData {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

interface SearchCodeData {
  query: string;
  results: Array<{ path: string; line: number; text: string }>;
}

interface GitStatusData {
  status: string;
}

interface GitDiffData {
  diff: string;
  truncated: boolean;
}

let tempRoot: string;
let repoPath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-tools-"));
  repoPath = path.join(tempRoot, "repo");

  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "README.md"), "# Demo Repo\n\nhello upload\n", "utf8");
  await fs.writeFile(path.join(repoPath, "src", "App.ts"), "export class UploadService {}\n", "utf8");
  await fs.writeFile(path.join(repoPath, "node_modules", "left-pad", "index.js"), "ignored\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "outside.txt"), "outside\n", "utf8");

  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await fs.appendFile(path.join(repoPath, "README.md"), "\nchanged line\n", "utf8");
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("ToolRegistry", () => {
  it("registers and executes tools with input validation", async () => {
    const registry = new ToolRegistry();
    registry.register(new ListFilesTool());

    expect(registry.list()).toEqual([
      {
        name: "list_files",
        description: "List files and directories under a repository path.",
        permissionLevel: "SAFE",
      },
    ]);

    const result = await registry.execute("list_files", { path: "." }, { repoPath });
    expectSuccess<ListFilesData>(result);
    expect(result.data.items.some((item) => item.path === "README.md")).toBe(true);
  });

  it("returns a structured error when a tool does not exist", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("missing_tool", {}, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("returns a structured error when input is invalid", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", { path: "README.md", maxLines: 999 }, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
  });
});

describe("read-only repository tools", () => {
  it("list_files lists files and ignores configured directories", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("list_files", { path: ".", maxDepth: 2 }, { repoPath });

    expectSuccess<ListFilesData>(result);
    expect(result.data.items).toContainEqual({ path: "README.md", type: "file" });
    expect(result.data.items).toContainEqual({ path: "src", type: "directory" });
    expect(result.data.items).toContainEqual({ path: "src/App.ts", type: "file" });
    expect(result.data.items.some((item) => item.path.startsWith("node_modules"))).toBe(false);
    expect(result.data.items.some((item) => item.path.startsWith(".git"))).toBe(false);
  });

  it("read_file reads a selected file range", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", {
      path: "README.md",
      startLine: 1,
      maxLines: 2,
    }, { repoPath });

    expectSuccess<ReadFileData>(result);
    expect(result.data.path).toBe("README.md");
    expect(result.data.startLine).toBe(1);
    expect(result.data.endLine).toBe(2);
    expect(result.data.content).toContain("# Demo Repo");
  });

  it("read_file prevents access outside the repository", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", { path: "../outside.txt" }, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_REPOSITORY");
    expect(result.error?.message).toBe("Path is outside repository");
  });

  it("search_code finds matching code with ripgrep", async () => {
    if (!(await hasRipgrep())) {
      return;
    }

    const registry = createDefaultToolRegistry();

    const result = await registry.execute("search_code", { query: "UploadService", path: "." }, { repoPath });

    expectSuccess<SearchCodeData>(result);
    expect(result.data.results).toContainEqual({
      path: "src/App.ts",
      line: 1,
      text: "export class UploadService {}",
    });
  });

  it("git_status returns status in a git repository", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("git_status", {}, { repoPath });

    expectSuccess<GitStatusData>(result);
    expect(result.data.status).toContain("README.md");
  });

  it("git_diff returns the current working tree diff", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("git_diff", {}, { repoPath });

    expectSuccess<GitDiffData>(result);
    expect(result.data.diff).toContain("+changed line");
    expect(result.data.truncated).toBe(false);
  });
});

function expectSuccess<T>(result: ToolResult<unknown>): asserts result is {
  success: true;
  data: T;
  metadata?: Record<string, unknown>;
} {
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
}

async function hasRipgrep(): Promise<boolean> {
  try {
    await execFileAsync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
