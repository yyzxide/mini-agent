import { extractKeywords, unique } from "./MemoryText.js";

export interface MemoryQuery {
  originalQuery: string;
  normalizedQuery: string;
  expandedQuery: string;
  keywords: string[];
  entities: string[];
  sameSessionBias: number;
  evidenceBudget: number;
  sessionId?: string;
  generatedAt: string;
}

export interface BuildMemoryQueryInput {
  query: string;
  sessionId?: string;
  recentMemory?: string;
  evidenceBudget?: number;
}

/**
 * Build retrieval features without locally reclassifying the user's task.
 * TaskFrame decides whether memory is relevant; this layer only normalizes the
 * selected semantic query and extracts generic lexical/entity signals.
 */
export function buildMemoryQuery(input: BuildMemoryQueryInput): MemoryQuery {
  const originalQuery = input.query.trim();
  const normalizedQuery = normalizeQuery(originalQuery);
  const recentContextTerms = input.recentMemory
    ? extractKeywords(input.recentMemory).slice(0, 12)
    : [];
  const keywords = unique([
    ...extractKeywords(normalizedQuery),
    ...recentContextTerms,
  ]);
  const entities = extractEntities(originalQuery, keywords);
  const expandedQuery = unique([
    normalizedQuery,
    ...entities,
    ...recentContextTerms,
  ].filter((item) => item.trim().length > 0)).join(" ");

  return {
    originalQuery,
    normalizedQuery,
    expandedQuery,
    keywords,
    entities,
    sameSessionBias: input.sessionId ? 1 : 0,
    evidenceBudget: clampEvidenceBudget(input.evidenceBudget ?? 5),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    generatedAt: new Date().toISOString(),
  };
}

function normalizeQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractEntities(originalQuery: string, keywords: string[]): string[] {
  const asciiEntities = originalQuery.match(
    /\b[A-Z][A-Za-z0-9_]{1,}\b|\b[a-zA-Z_][a-zA-Z0-9_]*\.(?:ts|js|java|cpp|py|html|md)\b/g,
  ) ?? [];
  const quoted = [...originalQuery.matchAll(/[`"'“”](.*?)[`"'“”]/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 1);
  const compactChinese = keywords
    .filter((keyword) => /[\u3400-\u9fff]/.test(keyword)
      && keyword.length >= 3
      && keyword.length <= 10)
    .slice(0, 10);

  return unique([...asciiEntities, ...quoted, ...compactChinese]);
}

function clampEvidenceBudget(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.floor(value)));
}
