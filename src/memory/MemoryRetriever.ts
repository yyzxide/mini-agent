import type { MemoryQuery } from "./MemoryQueryBuilder.js";
import type { LongTermMemorySearchResult } from "./LongTermMemoryStore.js";

export interface MemoryRetrievalOptions {
  limit?: number;
  minScore?: number;
  maxCandidates?: number;
  maxPerSession?: number;
  excludeSessionId?: string;
}

export interface MemoryRetriever {
  retrieve(query: MemoryQuery, options?: MemoryRetrievalOptions): Promise<LongTermMemorySearchResult[]>;
}
