import { z } from "zod";

export const TaskFrameSchema = z.object({
  version: z.literal(1).default(1),
  objective: z.string().trim().min(1).max(2_000),
  target: z.enum([
    "REPOSITORY",
    "WORLD",
    "PRODUCT",
    "SESSION",
    "DERIVATION",
    "MIXED",
  ]),
  answer: z.object({
    shape: z.enum([
      "DEFINITION",
      "COUNT",
      "ENUMERATION",
      "RELATION",
      "IDENTITY",
      "EXPLANATION",
      "FREEFORM",
    ]).default("FREEFORM"),
    depth: z.enum(["BRIEF", "BALANCED", "DETAILED"]).default("BALANCED"),
  }).default({
    shape: "FREEFORM",
    depth: "BALANCED",
  }),
  effects: z.object({
    answer: z.boolean().default(true),
    repositoryRead: z.boolean().default(false),
    repositoryWrite: z.enum(["NONE", "CONDITIONAL", "REQUIRED"]).default("NONE"),
    webEvidence: z.boolean().default(false),
    knowledgeEvidence: z.boolean().default(false),
    commandExecution: z.boolean().default(false),
    verification: z.enum(["NONE", "SYNTAX", "STATIC", "TEST"]).default("NONE"),
    verificationBasis: z.enum(["TASK_INFERRED", "USER_REQUIRED"]).default("TASK_INFERRED"),
    delegation: z.boolean().default(false),
    mcp: z.boolean().default(false),
  }),
  webEvidencePolicy: z.object({
    profile: z.enum([
      "ORDINARY",
      "CORROBORATED",
      "CURRENT",
      "HIGH_STAKES",
    ]).default("ORDINARY"),
    basis: z.enum([
      "GENERAL_LOOKUP",
      "USER_REQUESTED_CORROBORATION",
      "VOLATILE_CURRENT_CLAIM",
      "HIGH_STAKES_DOMAIN",
    ]).default("GENERAL_LOOKUP"),
    ranking: z.enum([
      "REPRESENTATIVE",
      "SUPERLATIVE",
    ]).default("REPRESENTATIVE"),
  }).default({
    profile: "ORDINARY",
    basis: "GENERAL_LOOKUP",
    ranking: "REPRESENTATIVE",
  }),
  constraints: z.object({
    readOnly: z.boolean().default(false),
    noWeb: z.boolean().default(false),
    noCommands: z.boolean().default(false),
    noDelegation: z.boolean().default(false),
    noMcp: z.boolean().default(false),
    requireCompleteFileRead: z.boolean().default(false),
  }),
  collaboration: z.object({
    requirement: z.enum(["NONE", "OPTIONAL", "REQUIRED"]).default("NONE"),
    changeProposal: z.boolean().default(false),
    review: z.boolean().default(false),
    requestedAgents: z.number().int()
      .transform((value) => clamp(value, 1, 3))
      .nullable()
      .default(null),
  }).default({
    requirement: "NONE",
    changeProposal: false,
    review: false,
    requestedAgents: null,
  }),
  conversationEvidence: z.object({
    purpose: z.enum([
      "CONTEXT",
      "REFERENT",
      "PRIOR_RESPONSE_AUDIT",
    ]).default("CONTEXT"),
    requiresHistory: z.boolean().default(false),
    queries: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
    includeRecentMessages: z.number().int()
      .transform((value) => clamp(value, 2, 12))
      .default(8),
  }).default({
    purpose: "CONTEXT",
    requiresHistory: false,
    queries: [],
    includeRecentMessages: 8,
  }),
  completionCriteria: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
  rationale: z.string().trim().min(1).max(800),
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export type TaskFrame = z.infer<typeof TaskFrameSchema>;

export interface ResolvedWebEvidencePolicy {
  profile: TaskFrame["webEvidencePolicy"]["profile"];
  searchViews: number;
  fetchedSources: number;
  independentDomains: number;
  citation: boolean;
  freshness: "NONE" | "CURRENT";
  authority: "NONE" | "REQUIRED";
  strict: boolean;
}

/**
 * The model classifies semantic evidence risk; deterministic policy owns the
 * concrete threshold. This prevents arbitrary model-supplied counts from
 * becoming hard postconditions while preserving autonomous intent judgment.
 */
export function resolveWebEvidencePolicy(
  policy: TaskFrame["webEvidencePolicy"],
): ResolvedWebEvidencePolicy {
  switch (policy.profile) {
    case "CORROBORATED":
      return {
        profile: policy.profile,
        searchViews: 2,
        fetchedSources: 2,
        independentDomains: 2,
        citation: true,
        freshness: "NONE",
        authority: "NONE",
        strict: true,
      };
    case "CURRENT":
      return {
        profile: policy.profile,
        searchViews: 2,
        fetchedSources: 1,
        independentDomains: 1,
        citation: true,
        freshness: "CURRENT",
        authority: "REQUIRED",
        strict: true,
      };
    case "HIGH_STAKES":
      return {
        profile: policy.profile,
        searchViews: 2,
        fetchedSources: 2,
        independentDomains: 2,
        citation: true,
        freshness: "CURRENT",
        authority: "REQUIRED",
        strict: true,
      };
    case "ORDINARY":
      return {
        profile: policy.profile,
        searchViews: 1,
        fetchedSources: 1,
        independentDomains: 1,
        citation: true,
        freshness: "NONE",
        authority: "NONE",
        strict: false,
      };
  }
}
