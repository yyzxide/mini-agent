import type { MemoryQuery } from "./MemoryQueryBuilder.js";
import type { MemoryRetrievalOptions } from "./MemoryRetriever.js";
import type { LongTermMemorySearchResult } from "./LongTermMemoryStore.js";

export function selectMemoryEvidence(
  results: LongTermMemorySearchResult[],
  query: MemoryQuery,
  options: MemoryRetrievalOptions = {},
): LongTermMemorySearchResult[] {
  const limit = options.limit ?? query.evidenceBudget;
  const maxPerSession = options.maxPerSession ?? 2;
  const selected: LongTermMemorySearchResult[] = [];
  const perSessionCount = new Map<string, number>();

  for (const result of results) {
    if (selected.length >= limit) {
      break;
    }

    const sessionCount = perSessionCount.get(result.entry.sessionId) ?? 0;
    if (sessionCount >= maxPerSession && selected.length > 0) {
      continue;
    }

    perSessionCount.set(result.entry.sessionId, sessionCount + 1);
    selected.push({
      ...result,
      selectionReasons: [
        ...(result.selectionReasons ?? []),
        selected.length === 0 ? "top-evidence" : "diverse-evidence",
      ],
    });
  }

  return selected;
}
