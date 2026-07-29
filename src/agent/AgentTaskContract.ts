import type { TaskChangeMode } from "../session/TaskChangeLogStore.js";
import type { ToolSpec } from "../llm/LlmClient.js";
import type { TaskFrame } from "../runtime/TaskFrame.js";

export type AgentTaskKind = "AGENT_TASK";

export type AgentOutputKind =
  | "TASK_RESULT"
  | "IMPLEMENTATION_PLAN";

export interface AgentCapabilities {
  repositoryRead: boolean;
  repositoryWrite: boolean;
  commandExecution: boolean;
  webAccess: boolean;
  knowledgeAccess: boolean;
  delegation: boolean;
  mcpAccess: boolean;
}

export interface AgentEvidenceRequirements {
  repositoryRead: boolean;
  completeFileRead: boolean;
  webSearch: boolean;
  webSearchViewCount: number;
  fetchedWebSourceCount: number;
  independentWebDomainCount: number;
  webCitation: boolean;
  webFreshnessRequired: boolean;
  webAuthorityRequired: boolean;
  knowledgeSearch: boolean;
}

export interface AgentTaskContract {
  version: 1;
  kind: AgentTaskKind;
  outputKind: AgentOutputKind;
  executionStrategy: "ITERATIVE";
  adaptationPolicy: "ADAPTIVE" | "FIXED_READ_ONLY";
  resultMode: TaskChangeMode;
  capabilities: AgentCapabilities;
  evidence: AgentEvidenceRequirements;
  maxSteps: number;
  instructions: string[];
  controlReason?: string;
  taskFrame?: TaskFrame;
  /** Exact MCP tool names authorized by TaskFrame capability negotiation. */
  mcpToolGrants?: string[];
}

const REPOSITORY_READ_TOOLS = new Set([
  "git_diff",
  "git_status",
  "list_files",
  "read_file",
  "search_code",
]);
const WEB_TOOLS = new Set(["web_search", "fetch_url"]);

export function createDefaultAgentTaskContract(): AgentTaskContract {
  return {
    version: 1,
    kind: "AGENT_TASK",
    outputKind: "TASK_RESULT",
    executionStrategy: "ITERATIVE",
    adaptationPolicy: "ADAPTIVE",
    resultMode: "AGENT_LOOP",
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
    maxSteps: 20,
    instructions: [
      "Compile the raw request into a TaskFrame before choosing actions.",
      "Safe tools are discoverable. Repository writes, commands, network access, delegation, and MCP calls require runtime authorization.",
    ],
  };
}

export function selectToolsForTaskContract(
  tools: ToolSpec[],
  contract: AgentTaskContract,
): ToolSpec[] {
  return tools.filter((tool) => isToolAllowedByTaskContract(tool, contract));
}

export function isToolAllowedByTaskContract(
  tool: ToolSpec | undefined,
  contract: AgentTaskContract,
): boolean {
  if (!tool) return false;
  if (tool.name === "apply_patch") return contract.capabilities.repositoryWrite;
  if (tool.name === "knowledge_search") return contract.capabilities.knowledgeAccess;
  if (WEB_TOOLS.has(tool.name)) return contract.capabilities.webAccess;
  if (REPOSITORY_READ_TOOLS.has(tool.name)) return contract.capabilities.repositoryRead;

  if (tool.source === "mcp") {
    if (!contract.capabilities.mcpAccess) return false;
    return contract.mcpToolGrants?.includes(tool.name) === true;
  }

  return false;
}

export function formatAgentTaskContract(contract: AgentTaskContract): string {
  const enabledCapabilities = Object.entries(contract.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const evidence = [
    contract.evidence.repositoryRead ? "read repository evidence before final" : undefined,
    contract.evidence.completeFileRead ? "read every line of the target file before final" : undefined,
    contract.evidence.webSearch ? "perform web_search before final" : undefined,
    contract.evidence.webSearchViewCount > 1
      ? `perform ${String(contract.evidence.webSearchViewCount)} non-equivalent search views`
      : undefined,
    contract.evidence.fetchedWebSourceCount > 0
      ? `fetch at least ${String(contract.evidence.fetchedWebSourceCount)} web source(s)`
      : undefined,
    contract.evidence.independentWebDomainCount > 0
      ? `use at least ${String(contract.evidence.independentWebDomainCount)} independent web domain(s)`
      : undefined,
    contract.evidence.webCitation ? "cite gathered source URLs verbatim" : undefined,
    contract.evidence.webFreshnessRequired ? "show visible freshness evidence" : undefined,
    contract.evidence.webAuthorityRequired ? "inspect an authority-targeted source" : undefined,
    contract.evidence.knowledgeSearch ? "perform knowledge_search before final" : undefined,
  ].filter((value): value is string => value !== undefined);

  return [
    `Task kind: ${contract.kind}`,
    `Output kind: ${contract.outputKind}`,
    `Execution strategy: ${contract.executionStrategy}`,
    `Capability adaptation: ${contract.adaptationPolicy}`,
    ...(contract.taskFrame ? [
      `Task objective: ${contract.taskFrame.objective}`,
      `Task target: ${contract.taskFrame.target}`,
      `Repository mutation: ${contract.taskFrame.effects.repositoryWrite}`,
      `Answer form: ${contract.taskFrame.answer.shape} / ${contract.taskFrame.answer.depth}`,
      `Task completion criteria: ${contract.taskFrame.completionCriteria.join(" | ") || "satisfy the objective"}`,
    ] : []),
    `Enabled capabilities: ${enabledCapabilities.join(", ") || "none"}`,
    ...(contract.mcpToolGrants?.length
      ? [`MCP tool grants: ${contract.mcpToolGrants.join(", ")}`]
      : []),
    `Evidence requirements: ${evidence.join("; ") || "none beyond an accurate answer"}`,
    "Task-specific instructions:",
    ...(contract.instructions.length > 0
      ? contract.instructions.map((instruction) => `- ${instruction}`)
      : ["- Follow the user request and the general runtime rules."]),
  ].join("\n");
}
