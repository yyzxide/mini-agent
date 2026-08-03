export type ProductCapabilityId =
  | "NATURAL_LANGUAGE_ANSWER"
  | "WEB_RESEARCH"
  | "REPOSITORY_READ"
  | "REPOSITORY_WRITE"
  | "COMMAND_EXECUTION"
  | "KNOWLEDGE_RAG"
  | "READ_ONLY_PLAN"
  | "MULTI_AGENT_COLLABORATION";

export interface ProductCapabilityDefinition {
  id: ProductCapabilityId;
  supported: true;
  effects: string[];
  /** Actual TOOL_CALL names exposed through availableTools. */
  tools: string[];
  /** Top-level AgentDecision actions; these are never TOOL_CALL names. */
  actions: string[];
  zh: {
    name: string;
    description: string;
    limitation?: string;
  };
  en: {
    name: string;
    description: string;
    limitation?: string;
  };
}

export const PRODUCT_CAPABILITY_REGISTRY: Readonly<Record<ProductCapabilityId, ProductCapabilityDefinition>> = {
  NATURAL_LANGUAGE_ANSWER: capability({
    id: "NATURAL_LANGUAGE_ANSWER",
    effects: ["answer"],
    tools: [],
    actions: ["FINAL"],
    zh: { name: "直接回答", description: "一般问题可以在统一 AgentLoop 的第一次决策中直接完成；如请求涉及本地文件，仍可自主使用安全的仓库读取工具。" },
    en: { name: "Direct answers", description: "General questions can finish on the first decision in the unified AgentLoop; safe repository read tools remain available when the request refers to local files." },
  }),
  WEB_RESEARCH: capability({
    id: "WEB_RESEARCH",
    effects: ["webEvidence"],
    tools: ["web_search", "fetch_url"],
    actions: [],
    zh: { name: "受控联网研究", description: "搜索公开网页并抓取公网 HTTP(S) 页面文本。", limitation: "不是常驻浏览器；实时结论仍受可访问来源和证据质量限制。" },
    en: { name: "Controlled web research", description: "Searches public web results and fetches text from public HTTP(S) pages.", limitation: "This is not a persistent browser; live answers still depend on accessible, sufficient sources." },
  }),
  REPOSITORY_READ: capability({
    id: "REPOSITORY_READ",
    effects: ["repositoryRead"],
    tools: ["list_files", "read_file", "search_code", "git_status", "git_diff", "verify_file"],
    actions: [],
    zh: { name: "仓库读取与分析", description: "读取、搜索、分析和审查当前仓库的代码、配置与文档。" },
    en: { name: "Repository reading and analysis", description: "Reads, searches, analyzes, and reviews code, configuration, and documentation in the current repository." },
  }),
  REPOSITORY_WRITE: capability({
    id: "REPOSITORY_WRITE",
    effects: ["repositoryWrite"],
    tools: [],
    actions: ["APPLY_PATCH"],
    zh: { name: "仓库文件修改", description: "通过受控补丁创建或修改代码、配置和文档文件。", limitation: "只有用户提出落盘任务时才为该请求开放。" },
    en: { name: "Repository file changes", description: "Creates or modifies code, configuration, and documentation through controlled patches.", limitation: "Enabled only for requests that ask for repository changes." },
  }),
  COMMAND_EXECUTION: capability({
    id: "COMMAND_EXECUTION",
    effects: ["commandExecution", "verification"],
    tools: [],
    actions: ["RUN_COMMAND"],
    zh: { name: "受控命令与验证", description: "运行受控命令完成测试、类型检查、构建和其他验证。" },
    en: { name: "Controlled commands and verification", description: "Runs controlled commands for tests, type checks, builds, and other verification." },
  }),
  KNOWLEDGE_RAG: capability({
    id: "KNOWLEDGE_RAG",
    effects: ["knowledgeEvidence"],
    tools: ["knowledge_search"],
    actions: [],
    zh: { name: "仓库文档 RAG", description: "查询已索引的仓库 Markdown/TXT 文档，并保留文件与行号引用。" },
    en: { name: "Repository document RAG", description: "Queries indexed repository Markdown/TXT documents and preserves file-and-line citations." },
  }),
  READ_ONLY_PLAN: capability({
    id: "READ_ONLY_PLAN",
    effects: ["readOnly"],
    tools: [],
    actions: ["PLAN"],
    zh: { name: "只读规划", description: "调查仓库并生成实施计划，同时在运行时阻止补丁和命令。" },
    en: { name: "Read-only planning", description: "Investigates the repository and produces an implementation plan while blocking patches and commands." },
  }),
  MULTI_AGENT_COLLABORATION: capability({
    id: "MULTI_AGENT_COLLABORATION",
    effects: ["delegation", "changeProposal", "review"],
    tools: [],
    actions: ["DELEGATE", "APPLY_DELEGATED_PATCH"],
    zh: {
      name: "多 Agent 协作",
      description: "根据任务语义自动委托仓库分析、临时 worktree 实现验证和变更审查；写入型子代理返回带基线与验证证据的补丁，由主 Agent 审核后合入。",
      limitation: "子代理不会直接修改主工作区；验证命令受允许列表限制，且不能再次委托或与用户交互。",
    },
    en: {
      name: "Multi-agent collaboration",
      description: "Semantically delegates repository analysis, implementation and verification in temporary worktrees, and change review; writing children return baseline-aware patches for parent review and merge.",
      limitation: "Children never mutate the parent worktree directly; verification commands are allowlisted, and children cannot delegate again or interact with the user.",
    },
  }),
};

export function getProductCapability(id: ProductCapabilityId): ProductCapabilityDefinition {
  return PRODUCT_CAPABILITY_REGISTRY[id];
}

export function listProductCapabilities(): ProductCapabilityDefinition[] {
  return Object.values(PRODUCT_CAPABILITY_REGISTRY);
}

export function formatCapabilityRegistryForPrompt(): string {
  return [
    "Authoritative Mini Coding Agent product capabilities:",
    ...listProductCapabilities().map((entry) => {
      const tools = entry.tools.length > 0 ? ` tools=${entry.tools.join(",")}` : "";
      const actions = entry.actions.length > 0 ? ` actions=${entry.actions.join(",")}` : "";
      return `- ${entry.id}: supported=true; task-frame-effects=${entry.effects.join(",")};${tools}${actions} ${entry.en.description}`;
    }),
    "TaskContract capabilities are per-request least-privilege boundaries. A capability disabled for the current request is not absent from the overall product.",
  ].join("\n");
}

const RESERVED_ACTION_ALIASES: Readonly<Record<string, string>> = {
  apply_patch: "APPLY_PATCH",
  run_command: "RUN_COMMAND",
};

export function decisionActionForReservedToolName(toolName: string): string | undefined {
  return RESERVED_ACTION_ALIASES[toolName];
}

function capability(
  input: Omit<ProductCapabilityDefinition, "supported">,
): ProductCapabilityDefinition {
  return { ...input, supported: true };
}
