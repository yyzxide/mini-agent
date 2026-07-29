import type { AgentOperatingMode } from "../agent/AgentOperatingMode.js";
import type { AgentTaskContract } from "../agent/AgentTaskContract.js";
import {
  resolveWebEvidencePolicy,
  type TaskFrame,
} from "./TaskFrame.js";

export function createTaskFrameBootstrapContract(input: {
  operatingMode?: AgentOperatingMode;
} = {}): AgentTaskContract {
  return {
    version: 1,
    kind: "AGENT_TASK",
    outputKind: input.operatingMode === "PLAN" ? "IMPLEMENTATION_PLAN" : "TASK_RESULT",
    executionStrategy: "ITERATIVE",
    adaptationPolicy: input.operatingMode === "PLAN" ? "FIXED_READ_ONLY" : "ADAPTIVE",
    resultMode: input.operatingMode === "PLAN" ? "PLAN" : "AGENT_LOOP",
    capabilities: {
      repositoryRead: true,
      repositoryWrite: false,
      commandExecution: false,
      webAccess: false,
      knowledgeAccess: false,
      delegation: false,
      mcpAccess: false,
    },
    evidence: {
      repositoryRead: false,
      completeFileRead: false,
      webSearch: false,
      webSearchViewCount: 0,
      fetchedWebSourceCount: 0,
      independentWebDomainCount: 0,
      webCitation: false,
      webFreshnessRequired: false,
      webAuthorityRequired: false,
      knowledgeSearch: false,
    },
    mcpToolGrants: [],
    maxSteps: 20,
    instructions: [
      "Unified semantic control: interpret the raw request through TaskFrame before choosing actions.",
      "Safe tools are discoverable. Select the next action autonomously; runtime policy authorizes each effect.",
    ],
  };
}

export function compileTaskFrameContract(input: {
  frame: TaskFrame;
  operatingMode: AgentOperatingMode;
  multiAgentAvailable: boolean;
}): AgentTaskContract {
  const { frame } = input;
  const planMode = input.operatingMode === "PLAN";
  const webPolicy = resolveWebEvidencePolicy(frame.webEvidencePolicy);
  return {
    ...createTaskFrameBootstrapContract({ operatingMode: input.operatingMode }),
    taskFrame: frame,
    capabilities: {
      repositoryRead: true,
      repositoryWrite: false,
      commandExecution: false,
      webAccess: false,
      knowledgeAccess: false,
      delegation: false,
      mcpAccess: false,
    },
    evidence: {
      repositoryRead: frame.effects.repositoryRead,
      completeFileRead: frame.constraints.requireCompleteFileRead,
      webSearch: frame.effects.webEvidence && !frame.constraints.noWeb,
      webSearchViewCount: frame.effects.webEvidence && !frame.constraints.noWeb
        ? webPolicy.searchViews
        : 0,
      fetchedWebSourceCount: frame.effects.webEvidence && !frame.constraints.noWeb
        ? webPolicy.fetchedSources
        : 0,
      independentWebDomainCount: frame.effects.webEvidence && !frame.constraints.noWeb
        ? webPolicy.independentDomains
        : 0,
      webCitation: frame.effects.webEvidence
        && !frame.constraints.noWeb
        && webPolicy.citation,
      webFreshnessRequired: frame.effects.webEvidence
        && !frame.constraints.noWeb
        && webPolicy.freshness === "CURRENT",
      webAuthorityRequired: frame.effects.webEvidence
        && !frame.constraints.noWeb
        && webPolicy.authority === "REQUIRED",
      knowledgeSearch: frame.effects.knowledgeEvidence,
    },
    maxSteps: planMode ? 14 : 20,
    instructions: [
      "TaskFrame is the semantic objective and evidence policy for this run.",
      "All safe tools may be discovered. Choose actions from the TaskFrame and current observations; runtime policy authorizes each requested effect.",
      `Objective: ${frame.objective}`,
      ...frame.completionCriteria.map((criterion) => `Completion criterion: ${criterion}`),
      ...(frame.constraints.readOnly
        ? ["The TaskFrame is read-only. Do not request repository writes or commands."]
        : []),
      ...(frame.constraints.noWeb ? ["The TaskFrame prohibits Web access."] : []),
      ...(frame.constraints.noCommands ? ["The TaskFrame prohibits command execution."] : []),
      ...(frame.constraints.noDelegation ? ["The TaskFrame prohibits delegation."] : []),
      ...(frame.constraints.noMcp ? ["The TaskFrame prohibits MCP tool calls."] : []),
      ...(frame.collaboration.requirement !== "NONE" && input.multiAgentAvailable
        ? ["The TaskFrame requests delegation; use DELEGATE when it materially advances the task."]
        : []),
    ],
    controlReason: `Semantic TaskFrame (${frame.confidence.toFixed(2)}): ${frame.rationale}`,
  };
}
