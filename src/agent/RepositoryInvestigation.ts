import path from "node:path";

const REVIEWABLE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".go", ".py", ".rb", ".php",
  ".rs", ".kt", ".kts", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".json", ".yaml",
  ".yml", ".xml", ".md", ".sh",
]);

export function looksLikeReviewableFilePath(value: string): boolean {
  const candidate = stripLineSuffix(value.trim());
  if (!candidate || candidate.length > 300) return false;
  if (/\s/.test(candidate)) return false;
  if (!REVIEWABLE_FILE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return false;
  return /[./\\]/.test(candidate) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(candidate);
}

export function extractLikelyReviewFilePath(text: string): string | undefined {
  const raw = text.trim();
  const quoted = raw.match(/^(["'`])(.+)\1$/)?.[2];
  const trimmed = quoted ?? raw;
  if ((quoted !== undefined || !/\s/.test(trimmed)) && looksLikeReviewableFilePath(trimmed)) {
    return stripLineSuffix(trimmed);
  }

  const matches = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+(?::\d+)?)/g) ?? [];
  for (const match of matches) {
    const candidate = stripLineSuffix(match);
    if (looksLikeReviewableFilePath(candidate)) return candidate;
  }
  return undefined;
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+$/, "");
}
