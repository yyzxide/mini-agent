const TEST_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\b(?:mvn|gradle|go)\s+test\b/i,
  /\b(?:pytest|vitest)\b/i,
  /\becho\s+test passed\b/i,
];

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}
