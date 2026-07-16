export const VERIFICATION_LEVELS = ["NONE", "DIFF_HYGIENE", "SYNTAX", "STATIC", "TEST"] as const;

export type VerificationLevel = typeof VERIFICATION_LEVELS[number];

export interface VerificationCommandClassification {
  level: VerificationLevel;
  category: "none" | "diff_hygiene" | "syntax" | "static" | "test";
  repositoryWide: boolean;
  scopePaths: string[];
}

const TEST_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\b(?:mvn|gradle|go|cargo)\s+test\b/i,
  /\b(?:dotnet|swift)\s+test\b/i,
  /\b(?:pytest|vitest|jest|unittest)\b/i,
];

const STATIC_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|check|build)\b/i,
  /\b(?:npx|pnpx|yarn|bunx|npm\s+exec|pnpm\s+exec)\s+(?:eslint|tsc)\b/i,
  /\btsc\b[^\n]*--noEmit\b/i,
  /\b(?:mvn|gradle)\s+(?:check|verify|build)\b/i,
  /\bcargo\s+(?:check|clippy|build)\b/i,
  /\bgo\s+(?:vet|build)\b/i,
  /\b(?:mypy|pyright|ruff\s+check|eslint)\b/i,
  /\b(?:make|cmake\s+--build)\b/i,
  /(?:^|\s)(?:c\+\+|g\+\+|clang\+\+|gcc|clang)(?:\s|$)[^\n]*(?:-fsyntax-only|-c)(?:\s|$)/i,
  /\b(?:dotnet|swift)\s+build\b/i,
  /(?:^|\s)(?:javac|kotlinc|rustc)(?:\s|$)/i,
  /\b(?:swiftc\s+-typecheck|shellcheck)\b/i,
];

const SYNTAX_COMMAND_PATTERNS = [
  /\bnode\s+--check\b/i,
  /\bpython3?\s+-m\s+(?:py_compile|compileall)\b/i,
  /\b(?:ruby\s+-c|php\s+-l|bash\s+-n|sh\s+-n)\b/i,
];

const REPOSITORY_WIDE_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b/i,
  /\b(?:mvn|gradle|cargo|go)\s+(?:test|check|verify|build|vet|clippy)\b/i,
  /\b(?:dotnet|swift)\s+(?:test|build)\b/i,
  /\b(?:pytest|vitest|jest|unittest)\b/i,
  /\b(?:make|cmake\s+--build)\b/i,
];

const PATH_PATTERN = /(?:^|\s|["'])(\.?\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cpp|cc|c|h|hpp|cs|kt|kts|swift|rb|php|sh|bash|vue|svelte|json|ya?ml|toml|xml))(?:$|\s|["'])/gi;

const LEVEL_RANK: Record<VerificationLevel, number> = {
  NONE: 0,
  DIFF_HYGIENE: 1,
  SYNTAX: 2,
  STATIC: 3,
  TEST: 4,
};

export function classifyVerificationCommand(command: string): VerificationCommandClassification {
  const level = TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    ? "TEST"
    : STATIC_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
      ? "STATIC"
      : SYNTAX_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
        ? "SYNTAX"
        : /\bgit\s+diff\s+--check\b/i.test(command)
          ? "DIFF_HYGIENE"
          : "NONE";
  return {
    level,
    category: level === "NONE" ? "none" : level.toLowerCase() as VerificationCommandClassification["category"],
    repositoryWide: level !== "NONE" && REPOSITORY_WIDE_PATTERNS.some((pattern) => pattern.test(command)),
    scopePaths: extractScopePaths(command),
  };
}

export function isTestCommand(command: string): boolean {
  return classifyVerificationCommand(command).level === "TEST";
}

export function isVerificationCommand(command: string): boolean {
  return classifyVerificationCommand(command).level !== "NONE";
}

export function verificationLevelAtLeast(actual: VerificationLevel, required: VerificationLevel): boolean {
  return LEVEL_RANK[actual] >= LEVEL_RANK[required];
}

export function isVerificationRelevant(
  classification: Pick<VerificationCommandClassification, "repositoryWide" | "scopePaths">,
  targetFiles: string[],
): boolean {
  if (classification.repositoryWide || targetFiles.length === 0 || classification.scopePaths.length === 0) return true;
  const normalizedTargets = targetFiles.map(normalizePath);
  return classification.scopePaths.map(normalizePath).some((scope) => normalizedTargets.some((target) => (
    scope === target || scope.startsWith(`${target}/`) || target.startsWith(`${scope}/`)
  )));
}

function extractScopePaths(command: string): string[] {
  return [...command.matchAll(PATH_PATTERN)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .map(normalizePath)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 20);
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/").replace(/^\/+/, "");
}
