import type { TaskChangeMode } from "../session/TaskChangeLogStore.js";
import type { ToolSpec } from "../llm/LlmClient.js";

export type AgentTaskKind =
  | "DIRECT_RESPONSE"
  | "WEB_RESEARCH"
  | "REPOSITORY_INVESTIGATION"
  | "REPOSITORY_TASK"
  | "KNOWLEDGE_QUERY";

export type AgentOutputKind =
  | "NATURAL_LANGUAGE"
  | "GROUNDED_WEB_ANSWER"
  | "CODE_REVIEW"
  | "REPOSITORY_ANALYSIS"
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
  fetchedWebSourceCount: number;
  independentWebDomainCount: number;
  webCitation: boolean;
  knowledgeSearch: boolean;
}

export interface AgentTaskContract {
  version: 1;
  kind: AgentTaskKind;
  outputKind: AgentOutputKind;
  executionStrategy: "SINGLE_SHOT" | "ITERATIVE";
  resultMode: TaskChangeMode;
  capabilities: AgentCapabilities;
  evidence: AgentEvidenceRequirements;
  maxSteps: number;
  instructions: string[];
  routeReason?: string;
  deterministicAnswer?: string;
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
    kind: "REPOSITORY_TASK",
    outputKind: "TASK_RESULT",
    executionStrategy: "ITERATIVE",
    resultMode: "AGENT_LOOP",
    capabilities: {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      webAccess: false,
      knowledgeAccess: false,
      delegation: false,
      mcpAccess: false,
    },
    evidence: {
      repositoryRead: false,
      completeFileRead: false,
      webSearch: false,
      fetchedWebSourceCount: 0,
      independentWebDomainCount: 0,
      webCitation: false,
      knowledgeSearch: false,
    },
    maxSteps: 20,
    instructions: [],
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
    if (contract.capabilities.repositoryWrite || contract.capabilities.commandExecution) return true;
    return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false;
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
    contract.evidence.fetchedWebSourceCount > 0
      ? `fetch at least ${String(contract.evidence.fetchedWebSourceCount)} web source(s)`
      : undefined,
    contract.evidence.independentWebDomainCount > 0
      ? `use at least ${String(contract.evidence.independentWebDomainCount)} independent web domain(s)`
      : undefined,
    contract.evidence.webCitation ? "cite gathered source URLs verbatim" : undefined,
    contract.evidence.knowledgeSearch ? "perform knowledge_search before final" : undefined,
  ].filter((value): value is string => value !== undefined);

  return [
    `Task kind: ${contract.kind}`,
    `Output kind: ${contract.outputKind}`,
    `Execution strategy: ${contract.executionStrategy}`,
    `Enabled capabilities: ${enabledCapabilities.join(", ") || "none"}`,
    `Evidence requirements: ${evidence.join("; ") || "none beyond an accurate answer"}`,
    "Task-specific instructions:",
    ...(contract.instructions.length > 0
      ? contract.instructions.map((instruction) => `- ${instruction}`)
      : ["- Follow the user request and the general runtime rules."]),
  ].join("\n");
}
