import fs from "node:fs/promises";
import path from "node:path";
import { GitManager } from "../git/GitManager.js";
import {
  DEFAULT_IGNORED_NAMES,
  normalizeRepoPath,
  pathExists,
  toPosixPath,
} from "../utils/fs.js";

export interface RepoStateAnalyzerOptions {
  repoPath: string;
  maxFiles?: number;
}

export interface RepoState {
  repoPath: string;
  git: {
    isRepository: boolean;
    branch: string | null;
    commit: string | null;
    status: string;
    changedFiles: ChangedFileState[];
    diffSummary: {
      fileCount: number;
      additions: number;
      deletions: number;
      stat: string;
    } | null;
  };
  project: {
    packageManager: string | null;
    buildFiles: string[];
    languages: Array<{ language: string; files: number }>;
    scripts: Record<string, string>;
    suggestedCommands: string[];
  };
}

export interface ChangedFileState {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  raw: string;
}

const BUILD_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "pom.xml",
  "go.mod",
  "CMakeLists.txt",
  "build.gradle",
  "settings.gradle",
  "gradlew",
];

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".java", "Java"],
  [".go", "Go"],
  [".py", "Python"],
  [".cpp", "C++"],
  [".cc", "C++"],
  [".cxx", "C++"],
  [".c", "C"],
  [".h", "C/C++"],
  [".hpp", "C++"],
  [".rs", "Rust"],
  [".kt", "Kotlin"],
  [".kts", "Kotlin"],
  [".cs", "C#"],
  [".php", "PHP"],
  [".rb", "Ruby"],
]);

export class RepoStateAnalyzer {
  private readonly repoPath: string;
  private readonly maxFiles: number;

  constructor(options: RepoStateAnalyzerOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
    this.maxFiles = options.maxFiles ?? 500;
  }

  async analyze(): Promise<RepoState> {
    const git = new GitManager({ repoPath: this.repoPath });
    const [isRepository, buildFiles, allFiles] = await Promise.all([
      git.isGitRepository(),
      this.findBuildFiles(),
      this.listProjectFiles(),
    ]);

    const status = isRepository ? await git.getStatus().catch(() => "") : "";
    const [branch, commit, diffSummary] = isRepository
      ? await Promise.all([
        git.getCurrentBranch().catch(() => null),
        git.getCurrentCommit().catch(() => null),
        git.generateDiffSummary().catch(() => null),
      ])
      : [null, null, null] as const;

    const scripts = await this.readPackageScripts();
    const packageManager = detectPackageManager(buildFiles);

    return {
      repoPath: this.repoPath,
      git: {
        isRepository,
        branch,
        commit,
        status,
        changedFiles: parseGitStatus(status),
        diffSummary,
      },
      project: {
        packageManager,
        buildFiles,
        languages: summarizeLanguages(allFiles),
        scripts,
        suggestedCommands: suggestCommands(buildFiles, scripts, packageManager),
      },
    };
  }

  private async findBuildFiles(): Promise<string[]> {
    const found: string[] = [];
    for (const fileName of BUILD_FILES) {
      if (await pathExists(path.join(this.repoPath, fileName))) {
        found.push(fileName);
      }
    }
    return found;
  }

  private async readPackageScripts(): Promise<Record<string, string>> {
    const packageJsonPath = path.join(this.repoPath, "package.json");
    const content = await fs.readFile(packageJsonPath, "utf8").catch(() => undefined);
    if (!content) {
      return {};
    }

    try {
      const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
      const scripts: Record<string, string> = {};
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        if (typeof command === "string") {
          scripts[name] = command;
        }
      }
      return scripts;
    } catch {
      return {};
    }
  }

  private async listProjectFiles(): Promise<string[]> {
    const files: string[] = [];
    await this.walk(this.repoPath, files);
    return files;
  }

  private async walk(directoryPath: string, files: string[]): Promise<void> {
    if (files.length >= this.maxFiles) {
      return;
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= this.maxFiles || DEFAULT_IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await this.walk(absolutePath, files);
        continue;
      }

      files.push(toPosixPath(path.relative(this.repoPath, absolutePath)));
    }
  }
}

export function formatRepoState(state: RepoState): string {
  const changedCount = state.git.changedFiles.length;
  const diff = state.git.diffSummary;
  const scripts = Object.keys(state.project.scripts);
  const languages = state.project.languages
    .slice(0, 5)
    .map((item) => `${item.language}(${item.files})`)
    .join(", ") || "(unknown)";

  return [
    "Repository state:",
    `- path: ${state.repoPath}`,
    `- git: ${formatGitLine(state)}`,
    `- changes: ${changedCount === 0 ? "clean working tree" : `${changedCount} changed file(s)`}`,
    diff && diff.stat ? `- diff summary: ${diff.stat}` : undefined,
    changedCount > 0 ? `- changed files: ${state.git.changedFiles.slice(0, 12).map((file) => `${file.indexStatus}${file.worktreeStatus} ${file.path}`).join(", ")}` : undefined,
    `- package manager: ${state.project.packageManager ?? "(unknown)"}`,
    `- build files: ${state.project.buildFiles.length > 0 ? state.project.buildFiles.join(", ") : "(none detected)"}`,
    `- languages: ${languages}`,
    `- package scripts: ${scripts.length > 0 ? scripts.slice(0, 12).join(", ") : "(none)"}`,
    `- suggested verification: ${state.project.suggestedCommands.length > 0 ? state.project.suggestedCommands.join(" && ") : "(none detected)"}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function parseGitStatus(status: string): ChangedFileState[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const rawPath = line.slice(3).trim();
      const pathName = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
      return {
        path: pathName,
        indexStatus,
        worktreeStatus,
        raw: line,
      };
    });
}

function formatGitLine(state: RepoState): string {
  if (!state.git.isRepository) {
    return "not a git repository";
  }

  const commit = state.git.commit ? state.git.commit.slice(0, 8) : "unknown";
  return `${state.git.branch || "(detached)"} @ ${commit}`;
}

function detectPackageManager(buildFiles: string[]): string | null {
  if (buildFiles.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (buildFiles.includes("yarn.lock")) {
    return "yarn";
  }
  if (buildFiles.includes("package-lock.json") || buildFiles.includes("package.json")) {
    return "npm";
  }
  if (buildFiles.includes("pom.xml")) {
    return "maven";
  }
  if (buildFiles.includes("go.mod")) {
    return "go";
  }
  if (buildFiles.includes("build.gradle") || buildFiles.includes("settings.gradle")) {
    return "gradle";
  }
  if (buildFiles.includes("CMakeLists.txt")) {
    return "cmake";
  }
  return null;
}

function summarizeLanguages(files: string[]): Array<{ language: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION.get(path.extname(file).toLowerCase());
    if (!language) {
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([language, fileCount]) => ({ language, files: fileCount }))
    .sort((left, right) => right.files - left.files || left.language.localeCompare(right.language));
}

function suggestCommands(
  buildFiles: string[],
  scripts: Record<string, string>,
  packageManager: string | null,
): string[] {
  const commands: string[] = [];

  if (scripts.verify) {
    commands.push(packageScriptCommand(packageManager, "verify"));
  } else {
    if (scripts.build) {
      commands.push(packageScriptCommand(packageManager, "build"));
    }
    if (scripts.test) {
      commands.push(packageScriptCommand(packageManager, "test"));
    }
  }
  if (buildFiles.includes("pom.xml")) {
    commands.push("mvn test");
  }
  if (buildFiles.includes("go.mod")) {
    commands.push("go test ./...");
  }
  if (buildFiles.includes("gradlew")) {
    commands.push("./gradlew test");
  } else if (buildFiles.includes("build.gradle")) {
    commands.push("gradle test");
  }

  return [...new Set(commands)];
}

function packageScriptCommand(packageManager: string | null, scriptName: string): string {
  if (packageManager === "pnpm") {
    return `pnpm ${scriptName}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${scriptName}`;
  }
  return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
}
