import type { MemoryQuery } from "./MemoryQueryBuilder.js";
import type { LongTermMemorySearchResult } from "./LongTermMemoryStore.js";
import type { MemoryKind, MemoryScope } from "./MemoryTypes.js";

export interface MemoryRetrievalOptions {
  limit?: number;
  minScore?: number;
  maxCandidates?: number;
  maxPerSession?: number;
  excludeSessionId?: string;
  allowedKinds?: MemoryKind[];
  allowedScopes?: MemoryScope[];
  minRerankScore?: number;
}

export interface MemoryRetriever {
  retrieve(query: MemoryQuery, options?: MemoryRetrievalOptions): Promise<LongTermMemorySearchResult[]>;
}
