import type { AgentOperatingMode } from "../../src/agent/AgentOperatingMode.js";
import type { AgentTaskContract } from "../../src/agent/AgentTaskContract.js";
import {
  TaskFrameSchema,
  type TaskFrame,
} from "../../src/runtime/TaskFrame.js";
import { compileTaskFrameContract } from "../../src/runtime/TaskFrameContract.js";

export interface TestTaskFrameOptions {
  objective: string;
  target?: TaskFrame["target"];
  answer?: Partial<TaskFrame["answer"]>;
  effects?: Partial<TaskFrame["effects"]>;
  webEvidencePolicy?: Partial<TaskFrame["webEvidencePolicy"]>;
  constraints?: Partial<TaskFrame["constraints"]>;
  collaboration?: Partial<TaskFrame["collaboration"]>;
  conversationEvidence?: Partial<TaskFrame["conversationEvidence"]>;
  completionCriteria?: string[];
  confidence?: number;
  rationale?: string;
  operatingMode?: AgentOperatingMode;
  multiAgentAvailable?: boolean;
}

export function createTestTaskFrame(options: TestTaskFrameOptions): TaskFrame {
  return TaskFrameSchema.parse({
    version: 1,
    objective: options.objective,
    target: options.target ?? "DERIVATION",
    answer: {
      shape: options.answer?.shape ?? "FREEFORM",
      depth: options.answer?.depth ?? "BALANCED",
    },
    effects: {
      answer: options.effects?.answer ?? true,
      repositoryRead: options.effects?.repositoryRead ?? false,
      repositoryWrite: options.effects?.repositoryWrite ?? "NONE",
      webEvidence: options.effects?.webEvidence ?? false,
      knowledgeEvidence: options.effects?.knowledgeEvidence ?? false,
      commandExecution: options.effects?.commandExecution ?? false,
      verification: options.effects?.verification ?? "NONE",
      verificationBasis: options.effects?.verificationBasis ?? "TASK_INFERRED",
      delegation: options.effects?.delegation ?? false,
      mcp: options.effects?.mcp ?? false,
    },
    webEvidencePolicy: {
      profile: options.webEvidencePolicy?.profile ?? "ORDINARY",
      basis: options.webEvidencePolicy?.basis ?? "GENERAL_LOOKUP",
      ranking: options.webEvidencePolicy?.ranking ?? "REPRESENTATIVE",
    },
    constraints: {
      readOnly: options.constraints?.readOnly ?? false,
      noWeb: options.constraints?.noWeb ?? false,
      noCommands: options.constraints?.noCommands ?? false,
      noDelegation: options.constraints?.noDelegation ?? false,
      noMcp: options.constraints?.noMcp ?? false,
      requireCompleteFileRead: options.constraints?.requireCompleteFileRead ?? false,
    },
    collaboration: {
      requirement: options.collaboration?.requirement ?? "NONE",
      changeProposal: options.collaboration?.changeProposal ?? false,
      review: options.collaboration?.review ?? false,
      requestedAgents: options.collaboration?.requestedAgents ?? null,
    },
    conversationEvidence: {
      purpose: options.conversationEvidence?.purpose ?? "CONTEXT",
      requiresHistory: options.conversationEvidence?.requiresHistory ?? false,
      queries: options.conversationEvidence?.queries ?? [],
      includeRecentMessages: options.conversationEvidence?.includeRecentMessages ?? 8,
    },
    completionCriteria: options.completionCriteria ?? ["Satisfy the test objective."],
    confidence: options.confidence ?? 1,
    ambiguities: [],
    rationale: options.rationale ?? "Explicit test fixture.",
  });
}

export function createTestTaskContract(
  options: TestTaskFrameOptions,
): AgentTaskContract {
  const operatingMode = options.operatingMode ?? "EXECUTE";
  return compileTaskFrameContract({
    frame: createTestTaskFrame(options),
    operatingMode,
    multiAgentAvailable: options.multiAgentAvailable ?? false,
  });
}
