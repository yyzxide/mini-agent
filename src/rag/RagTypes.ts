export interface RagDocument {
  source: string;
  title: string;
  text: string;
  sourceHash: string;
  tags: string[];
}

export interface RagChunkDraft {
  text: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
  heading?: string;
}

export interface RagChunk extends RagChunkDraft {
  id: string;
  source: string;
  title: string;
  sourceHash: string;
  contentHash: string;
  tags: string[];
  keywords: string[];
  vector: number[];
  embeddingProvider: string;
  createdAt: string;
  updatedAt: string;
  metadata: {
    chunkSize: number;
    overlap: number;
  };
}

export interface RagSkippedPath {
  path: string;
  reason: "UNSUPPORTED_TYPE" | "IGNORED_PATH" | "FILE_TOO_LARGE";
}

export interface RagLoadResult {
  documents: RagDocument[];
  skipped: RagSkippedPath[];
}

export interface RagIngestResult {
  inputPaths: string[];
  discoveredFiles: number;
  indexedFiles: number;
  unchangedFiles: number;
  indexedChunks: number;
  replacedChunks: number;
  totalChunks: number;
  skipped: RagSkippedPath[];
  indexPath: string;
  embeddingProvider: string;
}

export interface RagSearchResult {
  chunk: Pick<RagChunk, "id" | "source" | "title" | "text" | "startLine" | "endLine" | "chunkIndex" | "heading" | "tags">;
  score: number;
  vectorScore: number;
  keywordScore: number;
  matchedKeywords: string[];
  citation: string;
  excerpt: string;
}

export type RagNoEvidenceReason = "EMPTY_QUERY" | "EMPTY_INDEX" | "EMBEDDING_PROVIDER_MISMATCH" | "INSUFFICIENT_EVIDENCE";

export interface RagSearchResponse {
  query: string;
  found: boolean;
  reason?: RagNoEvidenceReason;
  results: RagSearchResult[];
  context: string;
  citations: string[];
  embeddingProvider: string;
}

export interface RagSearchOptions {
  topK?: number;
  minScore?: number;
  source?: string;
  tags?: string[];
  maxContextChars?: number;
}

export interface RagStats {
  totalChunks: number;
  sources: number;
  bySource: Record<string, number>;
  byEmbeddingProvider: Record<string, number>;
  tags: Record<string, number>;
  indexPath: string;
  activeEmbeddingProvider: string;
}

export interface RagEvalCase {
  id?: string;
  query: string;
  relevantSources?: string[];
  expectNoAnswer?: boolean;
  topK?: number;
}

export interface RagEvalCaseResult {
  id: string;
  query: string;
  passed: boolean;
  found: boolean;
  retrievedSources: string[];
  relevantSources: string[];
  recallAtK: number;
  reciprocalRank: number;
}

export interface RagEvalResult {
  total: number;
  passed: number;
  answerabilityAccuracy: number;
  hitRate: number;
  meanRecallAtK: number;
  meanReciprocalRank: number;
  cases: RagEvalCaseResult[];
}
