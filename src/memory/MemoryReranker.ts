import type { MemoryQuery } from "./MemoryQueryBuilder.js";
import type { LongTermMemorySearchResult } from "./LongTermMemoryStore.js";

export interface MemoryRerankOptions {
  now?: Date;
}

const RECENCY_HALF_LIFE_DAYS = 30;

export function rerankMemoryResults(
  results: LongTermMemorySearchResult[],
  query: MemoryQuery,
  options: MemoryRerankOptions = {},
): LongTermMemorySearchResult[] {
  const now = options.now ?? new Date();

  return results
    .map((result) => rerankMemoryResult(result, query, now))
    .sort((left, right) => right.score - left.score);
}

function rerankMemoryResult(
  result: LongTermMemorySearchResult,
  query: MemoryQuery,
  now: Date,
): LongTermMemorySearchResult {
  const recencyScore = calculateRecencyScore(result.entry.updatedAt, now);
  const sameSessionScore = query.sessionId && result.entry.sessionId === query.sessionId ? 1 : 0;
  const entityScore = calculateEntityScore(result, query);
  const sourceScore = result.entry.source === "TASK_SUMMARY" ? 0.05 : 0.025;
  const finalScore = clampScore(
    result.score * 0.72
      + recencyScore * 0.10
      + sameSessionScore * query.sameSessionBias * 0.08
      + entityScore * 0.05
      + sourceScore,
  );
  const selectionReasons = buildRerankReasons({
    result,
    query,
    recencyScore,
    sameSessionScore,
    entityScore,
    sourceScore,
  });

  return {
    ...result,
    rawScore: result.rawScore ?? result.score,
    rerankScore: finalScore,
    score: finalScore,
    selectionReasons,
  };
}

function calculateEntityScore(result: LongTermMemorySearchResult, query: MemoryQuery): number {
  if (query.entities.length === 0) {
    return 0;
  }

  const haystack = `${result.entry.title}\n${result.entry.text}`.toLowerCase();
  const matches = query.entities.filter((entity) => haystack.includes(entity.toLowerCase()));
  return matches.length / query.entities.length;
}

function calculateRecencyScore(timestamp: string, now: Date): number {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) {
    return 0;
  }

  const ageMs = Math.max(0, now.getTime() - time);
  const ageDays = ageMs / 86_400_000;
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

function buildRerankReasons(input: {
  result: LongTermMemorySearchResult;
  query: MemoryQuery;
  recencyScore: number;
  sameSessionScore: number;
  entityScore: number;
  sourceScore: number;
}): string[] {
  const reasons: string[] = [];

  if (input.result.matchedKeywords.length > 0) {
    reasons.push(`keyword:${input.result.matchedKeywords.slice(0, 5).join(",")}`);
  }
  if (input.sameSessionScore > 0) {
    reasons.push("same-session");
  }
  if (input.entityScore > 0) {
    reasons.push("entity-match");
  }
  if (input.recencyScore > 0.65) {
    reasons.push("recent");
  }
  if (input.sourceScore > 0) {
    reasons.push(`source:${input.result.entry.source}`);
  }

  return reasons;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}
