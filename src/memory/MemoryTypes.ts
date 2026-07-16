import type { JsonObject } from "../session/SessionTypes.js";

export const MEMORY_SCHEMA_VERSION = 2 as const;

export const MEMORY_KINDS = [
  "USER_PREFERENCE",
  "PROJECT_CONVENTION",
  "ARCHITECTURE_DECISION",
  "SESSION_SUMMARY",
  "VERIFIED_OUTCOME",
  "ERROR_SOLUTION",
  "PLAN",
  "EPHEMERAL_FACT",
] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];

export const MEMORY_SCOPES = ["SESSION", "REPOSITORY", "USER"] as const;
export type MemoryScope = typeof MEMORY_SCOPES[number];

export type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "EXPIRED";

export interface MemoryV2Fields {
  schemaVersion?: 2;
  kind?: MemoryKind;
  scope?: MemoryScope;
  subject?: string;
  status?: MemoryStatus;
  evidenceRefs?: string[];
  validUntil?: string;
  supersedes?: string;
  supersededBy?: string;
}

export const STABLE_MEMORY_KINDS: MemoryKind[] = [
  "USER_PREFERENCE",
  "PROJECT_CONVENTION",
  "ARCHITECTURE_DECISION",
];

export const HISTORICAL_MEMORY_KINDS: MemoryKind[] = [
  ...STABLE_MEMORY_KINDS,
  "SESSION_SUMMARY",
  "VERIFIED_OUTCOME",
  "ERROR_SOLUTION",
];

export function inferLegacyMemoryKind(input: {
  source: string;
  text: string;
  metadata: JsonObject;
}): MemoryKind {
  const mode = typeof input.metadata.mode === "string" ? input.metadata.mode : "";
  if (mode === "PLAN") {
    return "PLAN";
  }
  if (mode === "WEB_ANSWER") {
    return "EPHEMERAL_FACT";
  }
  if (input.source === "MANUAL") {
    return classifyManualMemory(input.text).kind;
  }
  if (input.source === "MEMORY_COMPACTION") {
    return "SESSION_SUMMARY";
  }
  if (/(?:报错|错误|失败|修复|解决|error|failure|fixed|resolved)/i.test(input.text)) {
    return "ERROR_SOLUTION";
  }
  return "VERIFIED_OUTCOME";
}

export function inferLegacyMemoryScope(input: {
  source: string;
  kind: MemoryKind;
}): MemoryScope {
  if (input.kind === "USER_PREFERENCE") {
    return "USER";
  }
  if (input.source === "MEMORY_COMPACTION") {
    return "SESSION";
  }
  return "REPOSITORY";
}

export function classifyManualMemory(text: string): { kind: MemoryKind; scope: MemoryScope } {
  if (/(?:我希望|我的偏好|我习惯|请始终|不要自动|prefer|preference|always ask me|do not automatically)/i.test(text)) {
    return { kind: "USER_PREFERENCE", scope: "USER" };
  }
  if (/(?:决定|采用|架构|迁移到|技术选型|decision|architecture|migrate to|adopt)/i.test(text)) {
    return { kind: "ARCHITECTURE_DECISION", scope: "REPOSITORY" };
  }
  if (/(?:报错|错误|失败|修复|解决|error|failure|fix|resolved)/i.test(text)) {
    return { kind: "ERROR_SOLUTION", scope: "REPOSITORY" };
  }
  return { kind: "PROJECT_CONVENTION", scope: "REPOSITORY" };
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}
