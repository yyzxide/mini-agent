import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRepoState, parseGitStatus, RepoStateAnalyzer } from "../../src/context/RepoStateAnalyzer.js";

const execFileAsync = promisify(execFile);

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-repo-state-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "# Demo\n", "utf8");
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
    name: "demo",
    scripts: {
      build: "tsc -p tsconfig.json",
      test: "vitest run",
      verify: "npm run build && npm test",
    },
  }, null, 2), "utf8");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const demo = true;\n", "utf8");
  await execFileAsync("git", ["add", "README.md", "package.json", "src/index.ts"], { cwd: repoPath });
  await fs.appendFile(path.join(repoPath, "README.md"), "\nchanged\n", "utf8");
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("RepoStateAnalyzer", () => {
  it("builds a higher-level repository state summary", async () => {
    const state = await new RepoStateAnalyzer({ repoPath }).analyze();
    const formatted = formatRepoState(state);

    expect(state.git.isRepository).toBe(true);
    expect(state.git.changedFiles.map((file) => file.path)).toContain("README.md");
    expect(state.project.packageManager).toBe("npm");
    expect(state.project.buildFiles).toContain("package.json");
    expect(state.project.scripts).toMatchObject({
      build: "tsc -p tsconfig.json",
      test: "vitest run",
    });
    expect(state.project.languages).toContainEqual({ language: "TypeScript", files: 1 });
    expect(state.project.suggestedCommands).toContain("npm run verify");
    expect(state.project.suggestedCommands).not.toContain("npm test");
    expect(formatted).toContain("Repository state:");
    expect(formatted).toContain("package scripts: build, test, verify");
  });

  it("parses short git status lines into changed file states", () => {
    expect(parseGitStatus(" M README.md\n?? src/new.ts\nR  old.ts -> new.ts\n")).toEqual([
      { path: "README.md", indexStatus: " ", worktreeStatus: "M", raw: " M README.md" },
      { path: "src/new.ts", indexStatus: "?", worktreeStatus: "?", raw: "?? src/new.ts" },
      { path: "new.ts", indexStatus: "R", worktreeStatus: " ", raw: "R  old.ts -> new.ts" },
    ]);
  });
});
