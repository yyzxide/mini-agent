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
    delegation: z.boolean().default(false),
    mcp: z.boolean().default(false),
  }).passthrough(),
  webEvidencePolicy: z.object({
    searchViews: z.number().int().min(1).max(4).default(1),
    fetchedSources: z.number().int().min(1).max(4).default(1),
    independentDomains: z.number().int().min(1).max(4).default(1),
    citation: z.boolean().default(true),
    freshness: z.enum(["NONE", "CURRENT"]).default("NONE"),
    authority: z.enum(["NONE", "REQUIRED"]).default("NONE"),
  }).default({
    searchViews: 1,
    fetchedSources: 1,
    independentDomains: 1,
    citation: true,
    freshness: "NONE",
    authority: "NONE",
  }),
  constraints: z.object({
    readOnly: z.boolean().default(false),
    noWeb: z.boolean().default(false),
    noCommands: z.boolean().default(false),
    noDelegation: z.boolean().default(false),
    noMcp: z.boolean().default(false),
    requireCompleteFileRead: z.boolean().default(false),
  }).passthrough(),
  collaboration: z.object({
    requirement: z.enum(["NONE", "OPTIONAL", "REQUIRED"]).default("NONE"),
    changeProposal: z.boolean().default(false),
    review: z.boolean().default(false),
    requestedAgents: z.number().int().min(1).max(3).nullable().default(null),
  }).default({
    requirement: "NONE",
    changeProposal: false,
    review: false,
    requestedAgents: null,
  }),
  conversationEvidence: z.object({
    requiresHistory: z.boolean().default(false),
    queries: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
    includeRecentMessages: z.number().int().min(2).max(12).default(8),
  }).default({
    requiresHistory: false,
    queries: [],
    includeRecentMessages: 8,
  }),
  completionCriteria: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
  rationale: z.string().trim().min(1).max(800),
}).passthrough();

export type TaskFrame = z.infer<typeof TaskFrameSchema>;

export function createFallbackTaskFrame(userGoal: string, reason: string): TaskFrame {
  return {
    version: 1,
    objective: userGoal.trim() || "Respond to the current user request.",
    target: "MIXED",
    answer: {
      shape: "FREEFORM",
      depth: "BALANCED",
    },
    effects: {
      answer: true,
      repositoryRead: false,
      repositoryWrite: "NONE",
      webEvidence: false,
      knowledgeEvidence: false,
      commandExecution: false,
      verification: "NONE",
      delegation: false,
      mcp: false,
    },
    webEvidencePolicy: {
      searchViews: 1,
      fetchedSources: 1,
      independentDomains: 1,
      citation: true,
      freshness: "NONE",
      authority: "NONE",
    },
    constraints: {
      readOnly: false,
      noWeb: false,
      noCommands: false,
      noDelegation: false,
      noMcp: false,
      requireCompleteFileRead: false,
    },
    collaboration: {
      requirement: "NONE",
      changeProposal: false,
      review: false,
      requestedAgents: null,
    },
    conversationEvidence: {
      requiresHistory: false,
      queries: [],
      includeRecentMessages: 8,
    },
    completionCriteria: [
      "Satisfy the current user request using observed evidence and available actions.",
    ],
    confidence: 0,
    ambiguities: ["The semantic TaskFrame could not be parsed; the action loop must interpret the raw request."],
    rationale: reason.slice(0, 800),
  };
}

export function formatTaskFrame(frame: TaskFrame): string {
  return [
    `Objective: ${frame.objective}`,
    `Target: ${frame.target}`,
    `Answer form: ${frame.answer.shape} / ${frame.answer.depth}`,
    `Expected effects: ${formatEnabledEffects(frame)}`,
    `Repository mutation: ${frame.effects.repositoryWrite}`,
    `Web evidence policy: ${frame.effects.webEvidence
      ? `${String(frame.webEvidencePolicy.searchViews)} search view(s), ${String(frame.webEvidencePolicy.fetchedSources)} fetched source(s), freshness=${frame.webEvidencePolicy.freshness}, authority=${frame.webEvidencePolicy.authority}, citation=${String(frame.webEvidencePolicy.citation)}`
      : "not requested"}`,
    `Constraints: ${formatEnabledConstraints(frame)}`,
    `Completion criteria: ${frame.completionCriteria.length > 0
      ? frame.completionCriteria.join(" | ")
      : "Satisfy the objective with observed evidence."}`,
    `Conversation evidence: ${frame.conversationEvidence.requiresHistory
      ? frame.conversationEvidence.queries.join(" | ") || "history required"
      : "recent context only"}`,
    `Semantic confidence: ${frame.confidence.toFixed(2)}`,
    ...(frame.ambiguities.length > 0 ? [`Ambiguities: ${frame.ambiguities.join(" | ")}`] : []),
  ].join("\n");
}

function formatEnabledEffects(frame: TaskFrame): string {
  const effects = [
    frame.effects.answer ? "answer" : undefined,
    frame.effects.repositoryRead ? "repository-read" : undefined,
    frame.effects.repositoryWrite !== "NONE" ? "repository-write" : undefined,
    frame.effects.webEvidence ? "web-evidence" : undefined,
    frame.effects.knowledgeEvidence ? "knowledge-evidence" : undefined,
    frame.effects.commandExecution ? "command-execution" : undefined,
    frame.effects.verification !== "NONE" ? `verification:${frame.effects.verification}` : undefined,
    frame.effects.delegation ? "delegation" : undefined,
    frame.effects.mcp ? "mcp" : undefined,
  ].filter((value): value is string => value !== undefined);
  return effects.join(", ") || "answer";
}

function formatEnabledConstraints(frame: TaskFrame): string {
  const constraints = [
    frame.constraints.readOnly ? "read-only" : undefined,
    frame.constraints.noWeb ? "no-web" : undefined,
    frame.constraints.noCommands ? "no-commands" : undefined,
    frame.constraints.noDelegation ? "no-delegation" : undefined,
    frame.constraints.noMcp ? "no-mcp" : undefined,
    frame.constraints.requireCompleteFileRead ? "complete-file-read" : undefined,
  ].filter((value): value is string => value !== undefined);
  return constraints.join(", ") || "none";
}
