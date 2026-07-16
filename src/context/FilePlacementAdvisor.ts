import path from "node:path";
import { looksLikeDocumentCreationTask } from "../agent/ArtifactIntent.js";
import { pathExists, normalizeRepoPath, toPosixPath } from "../utils/fs.js";
import type { RepoState } from "./RepoStateAnalyzer.js";

export interface FilePlacementAdvisorOptions {
  repoPath: string;
}

export interface FilePlacementAdvice {
  inferredLanguage: string;
  artifactKind: "source" | "test" | "script" | "standalone_demo" | "documentation";
  suggestedPaths: string[];
  reasons: string[];
}

export class FilePlacementAdvisor {
  private readonly repoPath: string;

  constructor(options: FilePlacementAdvisorOptions) {
    this.repoPath = normalizeRepoPath(options.repoPath);
  }

  async advise(userGoal: string, repoState: RepoState): Promise<FilePlacementAdvice> {
    const normalized = userGoal.trim().toLowerCase();
    const artifactKind = detectArtifactKind(normalized);
    const inferredLanguage = detectLanguage(normalized, repoState, artifactKind);
    const baseName = inferBaseName(userGoal, inferredLanguage, artifactKind);
    const candidateDirectories = await detectCandidateDirectories(
      this.repoPath,
      repoState,
      inferredLanguage,
      artifactKind,
      /[\u3400-\u9fff]/.test(userGoal),
    );
    const suggestedPaths = buildSuggestedPaths(candidateDirectories, baseName, inferredLanguage, artifactKind);
    const reasons = buildReasons(repoState, inferredLanguage, artifactKind, candidateDirectories);

    return {
      inferredLanguage,
      artifactKind,
      suggestedPaths,
      reasons,
    };
  }
}

export function formatFilePlacementAdvice(advice: FilePlacementAdvice): string {
  return [
    `Inferred language/runtime: ${advice.inferredLanguage}`,
    `Inferred artifact kind: ${advice.artifactKind}`,
    "Suggested target paths:",
    ...advice.suggestedPaths.map((item, index) => `${index + 1}. ${item}`),
    "Rationale:",
    ...advice.reasons.map((item) => `- ${item}`),
  ].join("\n");
}

function detectArtifactKind(normalizedGoal: string): FilePlacementAdvice["artifactKind"] {
  if (looksLikeDocumentCreationTask(normalizedGoal)) {
    return "documentation";
  }

  if (containsAnyText(normalizedGoal, ["单元测试", "测试", "test", "spec"])) {
    return "test";
  }

  if (containsAnyText(normalizedGoal, ["脚本", "script"])) {
    return "script";
  }

  if (containsAnyText(normalizedGoal, ["页面", "html", "网页", "web", "浏览器", "2048", "游戏", "demo"])) {
    return "standalone_demo";
  }

  return "source";
}

function detectLanguage(
  normalizedGoal: string,
  repoState: RepoState,
  artifactKind: FilePlacementAdvice["artifactKind"],
): string {
  if (artifactKind === "documentation") {
    return "Markdown";
  }

  if (containsAnyText(normalizedGoal, ["c++", "cpp"])) {
    return "C++";
  }
  if (containsAnyText(normalizedGoal, ["typescript", "ts"])) {
    return "TypeScript";
  }
  if (containsAnyText(normalizedGoal, ["javascript", "js", "node"])) {
    return "JavaScript";
  }
  if (containsAnyText(normalizedGoal, ["python", "py"])) {
    return "Python";
  }
  if (containsAnyText(normalizedGoal, ["java"])) {
    return "Java";
  }
  if (containsAnyText(normalizedGoal, ["go", "golang"])) {
    return "Go";
  }
  if (containsAnyText(normalizedGoal, ["rust"])) {
    return "Rust";
  }
  if (containsAnyText(normalizedGoal, ["kotlin"])) {
    return "Kotlin";
  }
  if (containsAnyText(normalizedGoal, ["c#", "csharp", "dotnet"])) {
    return "C#";
  }
  if (containsAnyText(normalizedGoal, ["html", "css"])) {
    return "HTML";
  }

  if (artifactKind === "standalone_demo") {
    return "HTML";
  }

  return repoState.project.languages[0]?.language ?? "Text";
}

function inferBaseName(
  userGoal: string,
  inferredLanguage: string,
  artifactKind: FilePlacementAdvice["artifactKind"],
): string {
  const explicitPathMatch = userGoal.match(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|java|go|cpp|c|cc|rs|kt|cs|html|css|sh|md|markdown))/);
  if (explicitPathMatch?.[1]) {
    return path.basename(explicitPathMatch[1], path.extname(explicitPathMatch[1]));
  }

  const normalized = userGoal.toLowerCase();
  if (normalized.includes("2048")) {
    return "game_2048";
  }
  if (normalized.includes("two sum") || normalized.includes("两数之和")) {
    return inferredLanguage === "Java" || inferredLanguage === "Kotlin" || inferredLanguage === "C#"
      ? "TwoSum"
      : "two_sum";
  }
  if (normalized.includes("median") || normalized.includes("中位数") || normalized.includes("数据流")) {
    return inferredLanguage === "Java" || inferredLanguage === "Kotlin" || inferredLanguage === "C#"
      ? "MedianFinder"
      : "median_finder";
  }
  if (normalized.includes("longest valid parentheses") || normalized.includes("最长有效括号")) {
    return inferredLanguage === "Java" || inferredLanguage === "Kotlin" || inferredLanguage === "C#"
      ? "LongestValidParentheses"
      : "longest_valid_parentheses";
  }
  if (artifactKind === "documentation") {
    if (normalized.includes("architecture") || normalized.includes("架构")) {
      return "architecture";
    }
    if (normalized.includes("自身") || normalized.includes("self structure") || normalized.includes("self design")) {
      return "self_structure_design";
    }
    if (normalized.includes("api")) {
      return "api_guide";
    }
    return "design_document";
  }

  const englishWords = [...normalized.matchAll(/[a-z0-9]+/g)]
    .map((match) => match[0])
    .filter((word) => !COMMON_GOAL_WORDS.has(word));
  if (englishWords.length > 0) {
    const base = englishWords.slice(0, 3).join("_");
    return formatBaseNameForLanguage(base, inferredLanguage);
  }

  if (artifactKind === "standalone_demo") {
    return "demo_app";
  }
  if (artifactKind === "test") {
    return inferredLanguage === "Java" ? "GeneratedFeatureTest" : "generated_feature_test";
  }
  if (artifactKind === "script") {
    return "generated_script";
  }

  return inferredLanguage === "Java" || inferredLanguage === "Kotlin" || inferredLanguage === "C#"
    ? "GeneratedFeature"
    : "generated_feature";
}

function formatBaseNameForLanguage(value: string, language: string): string {
  if (language === "Java" || language === "Kotlin" || language === "C#") {
    return toPascalCase(value);
  }

  return toSnakeCase(value);
}

async function detectCandidateDirectories(
  repoPath: string,
  repoState: RepoState,
  inferredLanguage: string,
  artifactKind: FilePlacementAdvice["artifactKind"],
  preferLocalizedChineseDocs: boolean,
): Promise<string[]> {
  const candidates: string[] = [];
  const pushIfExists = async (relativePath: string): Promise<void> => {
    if (await pathExists(path.join(repoPath, relativePath))) {
      candidates.push(toPosixPath(relativePath));
    }
  };

  if (artifactKind === "documentation") {
    if (preferLocalizedChineseDocs) {
      await pushIfExists("docs/zh-CN");
      await pushIfExists("docs/zh-cn");
      await pushIfExists("docs/zh");
    }
    await pushIfExists("docs");
    await pushIfExists("documentation");
    candidates.push(".");
    return uniqueStrings(candidates);
  }

  if (artifactKind === "standalone_demo" && inferredLanguage === "HTML") {
    await pushIfExists("public");
    await pushIfExists("static");
    await pushIfExists("web");
    await pushIfExists("site");
    candidates.push(".");
    return uniqueStrings(candidates);
  }

  if (artifactKind === "test") {
    if (repoState.project.buildFiles.includes("pom.xml")) {
      await pushIfExists("src/test/java");
      candidates.push("src/test/java");
      return uniqueStrings(candidates);
    }

    await pushIfExists("tests");
    await pushIfExists("__tests__");
    await pushIfExists("src/__tests__");
    if (candidates.length === 0) {
      candidates.push("tests");
    }
    return uniqueStrings(candidates);
  }

  if (artifactKind === "script") {
    await pushIfExists("scripts");
    await pushIfExists("src/scripts");
  }

  switch (inferredLanguage) {
    case "TypeScript":
    case "JavaScript":
      await pushIfExists("src");
      await pushIfExists("app");
      break;
    case "Java":
      await pushIfExists("src/main/java");
      await pushIfExists("src");
      break;
    case "Kotlin":
      await pushIfExists("src/main/kotlin");
      await pushIfExists("src");
      break;
    case "Go":
      await pushIfExists("cmd");
      await pushIfExists("pkg");
      await pushIfExists("internal");
      break;
    case "Python":
      await pushIfExists("src");
      await pushIfExists("app");
      break;
    case "C++":
    case "C":
    case "Rust":
    case "C#":
      await pushIfExists("src");
      break;
    default:
      await pushIfExists("src");
      break;
  }

  candidates.push(".");
  return uniqueStrings(candidates);
}

function buildSuggestedPaths(
  directories: string[],
  baseName: string,
  inferredLanguage: string,
  artifactKind: FilePlacementAdvice["artifactKind"],
): string[] {
  const fileName = buildFileName(baseName, inferredLanguage, artifactKind);
  const suggestions = directories.map((directory) => buildPathForDirectory(directory, fileName, baseName, inferredLanguage));
  return uniqueStrings(suggestions).slice(0, 4);
}

function buildPathForDirectory(directory: string, fileName: string, baseName: string, inferredLanguage: string): string {
  if (inferredLanguage === "Go" && directory === "cmd") {
    return `cmd/${toSnakeCase(baseName)}/main.go`;
  }

  if (directory === "." || directory === "") {
    return fileName;
  }

  return `${directory}/${fileName}`;
}

function buildFileName(
  baseName: string,
  inferredLanguage: string,
  artifactKind: FilePlacementAdvice["artifactKind"],
): string {
  const extension = extensionForLanguage(inferredLanguage, artifactKind);
  if (artifactKind === "test") {
    switch (inferredLanguage) {
      case "TypeScript":
      case "JavaScript":
        return `${toSnakeCase(baseName)}.test${extension}`;
      case "Python":
        return `test_${toSnakeCase(baseName)}${extension}`;
      case "Go":
        return `${toSnakeCase(baseName)}_test.go`;
      case "Java":
      case "Kotlin":
      case "C#":
        return `${toPascalCase(baseName)}Test${extension}`;
      default:
        return `${toSnakeCase(baseName)}_test${extension}`;
    }
  }

  if (inferredLanguage === "Go" && extension === ".go") {
    return `${toSnakeCase(baseName)}.go`;
  }

  if (inferredLanguage === "Java" || inferredLanguage === "Kotlin" || inferredLanguage === "C#") {
    return `${toPascalCase(baseName)}${extension}`;
  }

  return `${toSnakeCase(baseName)}${extension}`;
}

function extensionForLanguage(inferredLanguage: string, artifactKind: FilePlacementAdvice["artifactKind"]): string {
  if (artifactKind === "documentation" || inferredLanguage === "Markdown") {
    return ".md";
  }

  if (artifactKind === "standalone_demo" && inferredLanguage === "HTML") {
    return ".html";
  }

  switch (inferredLanguage) {
    case "TypeScript":
      return ".ts";
    case "JavaScript":
      return ".js";
    case "Python":
      return ".py";
    case "Java":
      return ".java";
    case "Go":
      return ".go";
    case "Rust":
      return ".rs";
    case "Kotlin":
      return ".kt";
    case "C#":
      return ".cs";
    case "C++":
      return ".cpp";
    case "C":
      return ".c";
    case "HTML":
      return ".html";
    default:
      return ".txt";
  }
}

function buildReasons(
  repoState: RepoState,
  inferredLanguage: string,
  artifactKind: FilePlacementAdvice["artifactKind"],
  directories: string[],
): string[] {
  const reasons = [
    `detected build files: ${repoState.project.buildFiles.length > 0 ? repoState.project.buildFiles.join(", ") : "(none)"}`,
    `detected primary languages: ${repoState.project.languages.slice(0, 4).map((item) => `${item.language}(${item.files})`).join(", ") || "(unknown)"}`,
  ];

  if (artifactKind === "standalone_demo" && directories.some((directory) => ["public", "static", "web", "site"].includes(directory))) {
    reasons.push("standalone browser demos usually fit better in a static-web directory than beside library source files");
  }

  if (artifactKind === "script" && directories.some((directory) => directory.includes("scripts"))) {
    reasons.push("the repository already has a scripts-style directory, so utility scripts should prefer that area");
  }

  if (artifactKind === "documentation" && directories.some((directory) => directory.startsWith("docs"))) {
    reasons.push("the repository already has a docs-style directory, so Markdown documentation should stay with the existing documentation set");
  }

  if (inferredLanguage === "Java" && directories.includes("src/main/java")) {
    reasons.push("maven-style Java source usually belongs under src/main/java");
  }

  if (inferredLanguage === "TypeScript" && directories.includes("src")) {
    reasons.push("the repository already keeps implementation code under src/");
  }

  if (directories.includes(".")) {
    reasons.push("repository root remains a fallback when no better target directory exists");
  }

  return reasons;
}

function containsAnyText(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toSnakeCase(value: string): string {
  const parts = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .split("_")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return parts.join("_") || "generated_file";
}

function toPascalCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("") || "GeneratedFile";
}

const COMMON_GOAL_WORDS = new Set([
  "write",
  "create",
  "implement",
  "build",
  "make",
  "a",
  "an",
  "the",
  "code",
  "game",
  "demo",
  "for",
  "with",
  "using",
  "please",
]);
