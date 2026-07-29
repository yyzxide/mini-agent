import type { SessionRecord } from "../session/SessionTypes.js";
import {
  classifyManualMemory,
  HISTORICAL_MEMORY_KINDS,
  type MemoryKind,
  type MemoryScope,
  STABLE_MEMORY_KINDS,
} from "./MemoryTypes.js";
import { extractChangedPathsFromUnifiedDiff } from "../diff/ChangedPaths.js";

export interface MemoryReadPlan {
  retrieve: boolean;
  query: string;
  allowedKinds: MemoryKind[];
  allowedScopes: MemoryScope[];
  excludeActiveSession: boolean;
  reason: string;
}

export interface MemoryWritePlan {
  store: boolean;
  kind?: MemoryKind;
  scope?: MemoryScope;
  confidence?: number;
  validUntil?: string;
  evidenceRefs?: string[];
  reason: string;
}

export function planMemoryRead(input: {
  query: string;
  resolvedQuery?: string;
  repositoryWork: boolean;
  historicalRecall: boolean;
  webEvidence: boolean;
  indexedKnowledgeRequest?: boolean;
}): MemoryReadPlan {
  const query = input.resolvedQuery?.trim() || input.query.trim();
  if (!query) {
    return disabledReadPlan(query, "Empty queries do not retrieve memory.");
  }
  if (input.indexedKnowledgeRequest) {
    return disabledReadPlan(query, "Document knowledge-base requests must not mix in historical memory.");
  }
  if (input.webEvidence) {
    return disabledReadPlan(query, "Live or web facts must use current tool evidence rather than memory.");
  }

  if (input.historicalRecall) {
    return {
      retrieve: true,
      query,
      allowedKinds: [...HISTORICAL_MEMORY_KINDS],
      allowedScopes: ["SESSION", "REPOSITORY", "USER"],
      excludeActiveSession: true,
      reason: "The user explicitly requested historical recall or continuation.",
    };
  }

  if (input.repositoryWork) {
    return {
      retrieve: true,
      query,
      allowedKinds: [...STABLE_MEMORY_KINDS],
      allowedScopes: ["REPOSITORY", "USER"],
      excludeActiveSession: true,
      reason: "Repository work may use stable preferences, conventions, and architecture decisions only.",
    };
  }

  return disabledReadPlan(query, "Ordinary answers do not automatically select a historical topic.");
}

export function planSessionMemoryWrite(record: SessionRecord): MemoryWritePlan {
  if (record.type === "MEMORY_COMPACTION") {
    return {
      store: true,
      kind: "SESSION_SUMMARY",
      scope: "SESSION",
      confidence: 0.6,
      evidenceRefs: [`session-record:${record.id}`],
      reason: "Explicit session compaction is retained as lower-confidence historical context.",
    };
  }
  if (record.type !== "TASK_SUMMARY") {
    return { store: false, reason: "Only task summaries and explicit compactions are indexable." };
  }
  if (record.payload.success !== true) {
    return { store: false, reason: "Only explicitly successful task summaries are eligible." };
  }

  const finalDiff = typeof record.payload.finalDiff === "string" ? record.payload.finalDiff : "";
  const changedFiles = Array.isArray(record.payload.changedFiles)
    ? record.payload.changedFiles.filter((file): file is string => typeof file === "string")
    : [];
  const artifactId = typeof record.payload.artifactId === "string" ? record.payload.artifactId : "";
  if (!finalDiff.trim() && (!artifactId || changedFiles.length === 0)) {
    return { store: false, reason: "The task has no repository diff proving a durable outcome." };
  }
  const summary = typeof record.payload.summary === "string" ? record.payload.summary : "";
  return {
    store: true,
    kind: /(?:报错|错误|失败|修复|解决|error|failure|fixed|resolved)/i.test(summary)
      ? "ERROR_SOLUTION"
      : "VERIFIED_OUTCOME",
    scope: "REPOSITORY",
    confidence: 0.8,
    evidenceRefs: (changedFiles.length > 0 ? changedFiles : extractChangedPathsFromUnifiedDiff(finalDiff))
      .map((file) => `file:${file}`),
    reason: "A successful task with an actual repository diff is a verified durable outcome.",
  };
}

export function planManualMemoryWrite(input: {
  text: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  ttlDays?: number;
}): MemoryWritePlan {
  const inferred = classifyManualMemory(input.text);
  return {
    store: true,
    kind: input.kind ?? inferred.kind,
    scope: input.scope ?? inferred.scope,
    confidence: 1,
    ...(input.ttlDays !== undefined
      ? { validUntil: new Date(Date.now() + input.ttlDays * 86_400_000).toISOString() }
      : {}),
    evidenceRefs: [],
    reason: "The user explicitly requested this memory.",
  };
}

function disabledReadPlan(query: string, reason: string): MemoryReadPlan {
  return {
    retrieve: false,
    query,
    allowedKinds: [],
    allowedScopes: [],
    excludeActiveSession: true,
    reason,
  };
}
