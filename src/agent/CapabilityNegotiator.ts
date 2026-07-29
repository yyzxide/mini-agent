import type { ToolSpec } from "../llm/LlmClient.js";
import type { AgentDecision } from "./AgentDecision.js";
import type {
  AgentCapabilities,
  AgentTaskContract,
} from "./AgentTaskContract.js";
import { isToolAllowedByTaskContract } from "./AgentTaskContract.js";
import type { AgentOperatingMode } from "./AgentOperatingMode.js";

export interface CapabilityNegotiationInput {
  contract: AgentTaskContract;
  decision: AgentDecision;
  availableTools: ToolSpec[];
  operatingMode: AgentOperatingMode;
  multiAgentAvailable: boolean;
}

export interface CapabilityUpgrade {
  previousKind: AgentTaskContract["kind"];
  contract: AgentTaskContract;
  action: "APPLY_PATCH" | "APPLY_DELEGATED_PATCH" | "RUN_COMMAND" | "TOOL_CALL" | "DELEGATE";
  granted: Array<keyof AgentCapabilities>;
  grantedTools?: string[];
  reason: string;
}

export interface CapabilityDenial {
  code: "CAPABILITY_ADAPTATION_DENIED" | "MULTI_AGENT_DISABLED";
  reason: string;
}

export type CapabilityNegotiationResult =
  | { status: "UNCHANGED" }
  | { status: "UPGRADED"; upgrade: CapabilityUpgrade }
  | { status: "DENIED"; denial: CapabilityDenial };

interface DecisionRequirement {
  action: CapabilityUpgrade["action"];
  capabilities: Array<keyof AgentCapabilities>;
  mcpToolName?: string;
  mcpDestructive?: boolean;
}

/**
 * Tools can be discoverable before they are enabled. A model selection is a
 * semantic capability request; execution remains blocked until negotiate()
 * grants it. Fixed read-only contracts expose only already-enabled tools.
 */
export function selectToolsForCapabilityNegotiation(
  tools: ToolSpec[],
  contract: AgentTaskContract,
): ToolSpec[] {
  if (contract.adaptationPolicy === "FIXED_READ_ONLY") {
    return tools.filter((tool) =>
      isToolAllowedByTaskContract(tool, contract)
      || isRequestableSafeTaskFrameMcpTool(tool, contract),
    );
  }
  return tools.filter((tool) =>
    isToolAllowedByTaskContract(tool, contract)
    || (
      tool.name !== "apply_patch"
      && tool.annotations?.readOnlyHint === true
      && tool.annotations.destructiveHint === false
    )
    || (
      contract.taskFrame?.effects.mcp === true
      && contract.taskFrame.constraints.noMcp !== true
      && tool.source === "mcp"
    ),
  );
}

export function negotiateCapabilities(
  input: CapabilityNegotiationInput,
): CapabilityNegotiationResult {
  const inferredRequirement = inferDecisionRequirement(input.decision, input.availableTools);
  const requirement = inferredRequirement
    && (inferredRequirement.action === "APPLY_PATCH" || inferredRequirement.action === "APPLY_DELEGATED_PATCH")
    ? { ...inferredRequirement, capabilities: ["repositoryWrite"] as Array<keyof AgentCapabilities> }
    : inferredRequirement;
  if (!requirement || isRequirementSatisfied(input.contract, requirement)) {
    return { status: "UNCHANGED" };
  }

  const semanticConstraintDenial = validateTaskFrameSemanticConstraints(input.contract, requirement);
  if (semanticConstraintDenial) {
    return {
      status: "DENIED",
      denial: {
        code: "CAPABILITY_ADAPTATION_DENIED",
        reason: semanticConstraintDenial,
      },
    };
  }

  if (
    input.operatingMode === "PLAN"
    || input.contract.adaptationPolicy === "FIXED_READ_ONLY"
  ) {
    if (!(requirement.mcpToolName && requirement.mcpDestructive === false)) {
      return {
        status: "DENIED",
        denial: {
          code: "CAPABILITY_ADAPTATION_DENIED",
          reason: `The ${input.contract.kind} contract is fixed read-only and cannot grant ${requirement.capabilities.join(", ")} for ${requirement.action}.`,
        },
      };
    }
  }

  if (requirement.capabilities.includes("delegation") && !input.multiAgentAvailable) {
    return {
      status: "DENIED",
      denial: {
        code: "MULTI_AGENT_DISABLED",
        reason: "The model requested delegation, but no multi-agent coordinator is available for this run.",
      },
    };
  }

  const previousKind = input.contract.kind;
  const upgraded = requirement.mcpToolName
    ? buildMcpToolUpgrade(input, requirement.mcpToolName)
    : buildUpgradeContract(input, requirement.capabilities);
  const granted = requirement.capabilities.filter(
    (capability) =>
      !input.contract.capabilities[capability]
      && upgraded.capabilities[capability],
  );
  const grantedTools = requirement.mcpToolName
    && !input.contract.mcpToolGrants?.includes(requirement.mcpToolName)
    && upgraded.mcpToolGrants?.includes(requirement.mcpToolName)
    ? [requirement.mcpToolName]
    : [];
  if (granted.length === 0 && grantedTools.length === 0) {
    return {
      status: "DENIED",
      denial: {
        code: "CAPABILITY_ADAPTATION_DENIED",
        reason: `No safe capability upgrade is defined for ${requirement.action}.`,
      },
    };
  }

  return {
    status: "UPGRADED",
    upgrade: {
      previousKind,
      contract: upgraded,
      action: requirement.action,
      granted,
      ...(grantedTools.length > 0 ? { grantedTools } : {}),
      reason: `Model-selected ${requirement.action} requested ${[
        ...granted,
        ...grantedTools.map((tool) => `mcp:${tool}`),
      ].join(", ")} in the current AgentLoop.`,
    },
  };
}

function isRequestableSafeTaskFrameMcpTool(
  tool: ToolSpec,
  contract: AgentTaskContract,
): boolean {
  return contract.taskFrame?.effects.mcp === true
    && contract.taskFrame.constraints.noMcp !== true
    && tool.source === "mcp"
    && tool.annotations?.readOnlyHint === true
    && tool.annotations.destructiveHint === false;
}

function inferDecisionRequirement(
  decision: AgentDecision,
  availableTools: ToolSpec[],
): DecisionRequirement | undefined {
  switch (decision.type) {
    case "APPLY_PATCH":
    case "APPLY_DELEGATED_PATCH":
      return {
        action: decision.type,
        capabilities: ["repositoryWrite", "commandExecution"],
      };
    case "RUN_COMMAND":
      return { action: "RUN_COMMAND", capabilities: ["commandExecution"] };
    case "DELEGATE":
      return { action: "DELEGATE", capabilities: ["delegation"] };
    case "TOOL_CALL": {
      const tool = availableTools.find((candidate) => candidate.name === decision.toolName);
      if (!tool) return undefined;
      if (tool.name === "web_search" || tool.name === "fetch_url") {
        return { action: "TOOL_CALL", capabilities: ["webAccess"] };
      }
      if (tool.name === "knowledge_search") {
        return { action: "TOOL_CALL", capabilities: ["knowledgeAccess"] };
      }
      if (tool.source === "mcp") {
        return {
          action: "TOOL_CALL",
          capabilities: ["mcpAccess"],
          mcpToolName: tool.name,
          mcpDestructive: tool.annotations?.destructiveHint !== false
            || tool.annotations?.readOnlyHint !== true,
        };
      }
      if (["read_file", "list_files", "search_code", "git_status", "git_diff"].includes(tool.name)) {
        return { action: "TOOL_CALL", capabilities: ["repositoryRead"] };
      }
      return undefined;
    }
    case "PLAN":
    case "ASK_USER":
    case "FINAL":
    case "FAILED":
      return undefined;
  }
}

function buildUpgradeContract(
  input: CapabilityNegotiationInput,
  requested: Array<keyof AgentCapabilities>,
): AgentTaskContract {
  if (requested.includes("repositoryWrite")) {
    return buildRepositoryExecutionUpgrade(input);
  }
  if (requested.includes("webAccess")) {
    return buildWebUpgrade(input);
  }
  if (requested.includes("knowledgeAccess")) {
    return {
      ...input.contract,
      capabilities: mergeCapabilities(input.contract.capabilities, {
        knowledgeAccess: true,
      }),
      evidence: {
        ...input.contract.evidence,
        knowledgeSearch: true,
      },
      maxSteps: Math.max(input.contract.maxSteps, 8),
      controlReason: appendReason(input.contract, "Model-selected knowledge_search requested indexed knowledge."),
      instructions: unique([
        ...input.contract.instructions,
        "Use knowledge_search evidence and preserve its file-and-line citations.",
      ]),
    };
  }

  return {
    ...input.contract,
    capabilities: mergeCapabilities(
      input.contract.capabilities,
      Object.fromEntries(
        requested.map((capability) => [capability, true]),
      ) as Partial<AgentCapabilities>,
    ),
    maxSteps: Math.max(input.contract.maxSteps, 14),
    controlReason: appendReason(input.contract, `Model action requested ${requested.join(", ")}.`),
    instructions: unique([
      ...input.contract.instructions,
      "Capabilities were negotiated from the model's selected action. Execution remains subject to permission and sandbox policy.",
    ]),
  };
}

function buildMcpToolUpgrade(
  input: CapabilityNegotiationInput,
  toolName: string,
): AgentTaskContract {
  return {
    ...input.contract,
    capabilities: mergeCapabilities(input.contract.capabilities, {
      mcpAccess: true,
    }),
    mcpToolGrants: unique([...(input.contract.mcpToolGrants ?? []), toolName]),
    maxSteps: Math.max(input.contract.maxSteps, 14),
    controlReason: appendReason(
      input.contract,
      `Model-selected MCP tool ${toolName} requested an exact tool grant.`,
    ),
    instructions: unique([
      ...input.contract.instructions,
      `MCP tool ${toolName} is granted for this run only. Its own permission level still applies at execution.`,
    ]),
  };
}

function buildRepositoryExecutionUpgrade(
  input: CapabilityNegotiationInput,
): AgentTaskContract {
  return {
    ...input.contract,
    capabilities: mergeCapabilities(input.contract.capabilities, {
      repositoryWrite: true,
    }),
    maxSteps: Math.max(input.contract.maxSteps, 20),
    controlReason: appendReason(
      input.contract,
      "Model-selected repository write action was authorized.",
    ),
    instructions: unique([
      ...input.contract.instructions,
      "The model selected a repository write. Preserve prior evidence, apply the change, and verify the resulting state.",
    ]),
  };
}

function buildWebUpgrade(input: CapabilityNegotiationInput): AgentTaskContract {
  return {
    ...input.contract,
    capabilities: mergeCapabilities(input.contract.capabilities, {
      webAccess: true,
    }),
    evidence: {
      ...input.contract.evidence,
      webSearch: true,
      webSearchViewCount: Math.max(input.contract.evidence.webSearchViewCount, 1),
      fetchedWebSourceCount: Math.max(input.contract.evidence.fetchedWebSourceCount, 1),
      independentWebDomainCount: Math.max(input.contract.evidence.independentWebDomainCount, 1),
      webCitation: true,
    },
    maxSteps: Math.max(input.contract.maxSteps, 20),
    controlReason: appendReason(input.contract, "Model-selected Web action was authorized."),
    instructions: unique([
      ...input.contract.instructions,
      "Use gathered Web evidence only as one capability within this same AgentLoop; continue to repository actions when the objective requires them.",
    ]),
  };
}

function isRequirementSatisfied(
  contract: AgentTaskContract,
  requirement: DecisionRequirement,
): boolean {
  if (!requirement.capabilities.every((capability) => contract.capabilities[capability])) {
    return false;
  }
  return requirement.mcpToolName === undefined
    || contract.mcpToolGrants?.includes(requirement.mcpToolName) === true;
}

function mergeCapabilities(
  base: AgentCapabilities,
  ...overrides: Array<Partial<AgentCapabilities>>
): AgentCapabilities {
  const merged = { ...base };
  for (const override of overrides) {
    for (const capability of Object.keys(override) as Array<keyof AgentCapabilities>) {
      merged[capability] = merged[capability] || override[capability] === true;
    }
  }
  return merged;
}

function appendReason(contract: AgentTaskContract, reason: string): string {
  return `${contract.controlReason ?? "Initial task interpretation."} ${reason}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function validateTaskFrameSemanticConstraints(
  contract: AgentTaskContract,
  requirement: DecisionRequirement,
): string | undefined {
  if (!contract.taskFrame) return undefined;
  const { constraints } = contract.taskFrame;
  const requested = requirement.capabilities;
  if (
    constraints.readOnly
    && requested.some((capability) => capability === "repositoryWrite" || capability === "commandExecution")
  ) {
    return "The TaskFrame is explicitly read-only and cannot authorize repository writes or commands.";
  }
  if (constraints.noWeb && requested.includes("webAccess")) {
    return "The TaskFrame explicitly prohibits Web access.";
  }
  if (constraints.noCommands && requested.includes("commandExecution")) {
    return "The TaskFrame explicitly prohibits command execution.";
  }
  if (constraints.noDelegation && requested.includes("delegation")) {
    return "The TaskFrame explicitly prohibits delegation.";
  }
  if (constraints.noMcp && requirement.mcpToolName) {
    return "The TaskFrame explicitly prohibits MCP tool calls.";
  }
  if (constraints.readOnly && requirement.mcpDestructive) {
    return "The TaskFrame is explicitly read-only and cannot authorize a destructive MCP tool.";
  }
  return undefined;
}
