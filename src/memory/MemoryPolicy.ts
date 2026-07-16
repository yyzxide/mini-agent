import type { SessionRecord } from "../session/SessionTypes.js";
import {
  classifyManualMemory,
  HISTORICAL_MEMORY_KINDS,
  type MemoryKind,
  type MemoryScope,
  STABLE_MEMORY_KINDS,
} from "./MemoryTypes.js";

export type MemoryConsumerMode =
  | "AGENT_LOOP"
  | "DIRECT_ANSWER"
  | "WEB_ANSWER"
  | "CODE_REVIEW"
  | "REPOSITORY_ANALYSIS";

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
  mode: MemoryConsumerMode;
  resolvedQuery?: string;
  needsLiveData?: boolean;
  indexedKnowledgeRequest?: boolean;
}): MemoryReadPlan {
  const query = input.resolvedQuery?.trim() || input.query.trim();
  if (!query) {
    return disabledReadPlan(query, "Empty queries do not retrieve memory.");
  }
  if (input.indexedKnowledgeRequest) {
    return disabledReadPlan(query, "Document knowledge-base requests must not mix in historical memory.");
  }
  if (input.needsLiveData || input.mode === "WEB_ANSWER" || isVolatileQuery(query)) {
    return disabledReadPlan(query, "Live or web facts must use current tool evidence rather than memory.");
  }

  if (isExplicitHistoricalRecall(query)) {
    return {
      retrieve: true,
      query,
      allowedKinds: [...HISTORICAL_MEMORY_KINDS],
      allowedScopes: ["SESSION", "REPOSITORY", "USER"],
      excludeActiveSession: true,
      reason: "The user explicitly requested historical recall or continuation.",
    };
  }

  if (["AGENT_LOOP", "CODE_REVIEW", "REPOSITORY_ANALYSIS"].includes(input.mode)) {
    return {
      retrieve: true,
      query,
      allowedKinds: [...STABLE_MEMORY_KINDS],
      allowedScopes: ["REPOSITORY", "USER"],
      excludeActiveSession: true,
      reason: "Repository work may use stable preferences, conventions, and architecture decisions only.",
    };
  }

  return disabledReadPlan(query, "Ordinary direct answers do not automatically select a historical topic.");
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

  const mode = typeof record.payload.mode === "string" ? record.payload.mode : "";
  if (mode === "PLAN") {
    return { store: false, reason: "A successful plan is not an executed outcome." };
  }
  if (mode === "WEB_ANSWER") {
    return { store: false, reason: "Web answers may become stale and are not promoted automatically." };
  }
  if (mode === "DIRECT_ANSWER") {
    return { store: false, reason: "Transient direct answers are not long-term memory." };
  }
  if (mode !== "AGENT_LOOP") {
    return { store: false, reason: `Mode ${mode || "(missing)"} is not an automatically verified repository outcome.` };
  }
  if (record.payload.subMode === "REPOSITORY_ANALYSIS") {
    return { store: false, reason: "Repository analysis is current evidence, not a durable completed change." };
  }

  const finalDiff = typeof record.payload.finalDiff === "string" ? record.payload.finalDiff : "";
  if (!finalDiff.trim()) {
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
    evidenceRefs: extractDiffPaths(finalDiff).map((file) => `file:${file}`),
    reason: "A successful AgentLoop task with an actual diff is a verified repository outcome.",
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

export function isExplicitHistoricalRecall(query: string): boolean {
  return /(?:之前|上次|过去|历史|还记得|跨会话|继续之前|我们曾经|以前)|\b(?:previous|last time|history|historical|remember|continue the earlier|we discussed before)\b/i.test(query);
}

function isVolatileQuery(query: string): boolean {
  return /(?:今天|昨天|明天|现在|最新|实时|比分|赛果|股市|行情|汇率|新闻)|\b(?:today|yesterday|tomorrow|now|latest|live|score|stock|exchange rate|news)\b/i.test(query);
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

function extractDiffPaths(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value) && value !== "/dev/null");
}
