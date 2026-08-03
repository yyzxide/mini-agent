export const PRODUCT_CAPABILITY_IDS = [
  "NATURAL_LANGUAGE_ANSWER",
  "WEB_RESEARCH",
  "REPOSITORY_READ",
  "REPOSITORY_WRITE",
  "COMMAND_EXECUTION",
  "KNOWLEDGE_RAG",
  "READ_ONLY_PLAN",
  "MULTI_AGENT_COLLABORATION",
  "MCP_TOOL_RUNTIME",
  "SESSION_PERSISTENCE",
  "LONG_TERM_MEMORY",
  "DECLARATIVE_SKILLS",
  "AGENT_EVALUATION",
] as const;

export type ProductCapabilityId = typeof PRODUCT_CAPABILITY_IDS[number];

export interface ProductCapabilityDefinition {
  id: ProductCapabilityId;
  supported: true;
  effects: string[];
  /** Actual TOOL_CALL names exposed through availableTools. */
  tools: string[];
  /** Top-level AgentDecision actions; these are never TOOL_CALL names. */
  actions: string[];
  /** User-visible entry points that are neither TOOL_CALL names nor AgentDecision actions. */
  surfaces: string[];
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
    surfaces: [],
    zh: { name: "直接回答", description: "一般问题可以在统一 AgentLoop 的第一次决策中直接完成；如请求涉及本地文件，仍可自主使用安全的仓库读取工具。" },
    en: { name: "Direct answers", description: "General questions can finish on the first decision in the unified AgentLoop; safe repository read tools remain available when the request refers to local files." },
  }),
  WEB_RESEARCH: capability({
    id: "WEB_RESEARCH",
    effects: ["webEvidence"],
    tools: ["web_search", "fetch_url"],
    actions: [],
    surfaces: [],
    zh: { name: "受控联网研究", description: "搜索公开网页、拒绝常见无效页面、抓取有界正文，并为严格任务记录结论到来源的映射。", limitation: "不是常驻浏览器；来源血缘校验不等于语义蕴含证明，实时结论仍受可访问来源和证据质量限制。" },
    en: { name: "Controlled web research", description: "Searches public web results, rejects common unusable pages, fetches bounded text, and records strict claim-to-source mappings.", limitation: "This is not a persistent browser; provenance checks do not prove semantic entailment, and live answers still depend on accessible, sufficient sources." },
  }),
  REPOSITORY_READ: capability({
    id: "REPOSITORY_READ",
    effects: ["repositoryRead"],
    tools: ["list_files", "read_file", "search_code", "git_status", "git_diff", "verify_file"],
    actions: [],
    surfaces: [],
    zh: { name: "仓库读取与分析", description: "读取、搜索、分析和审查当前仓库的代码、配置与文档。" },
    en: { name: "Repository reading and analysis", description: "Reads, searches, analyzes, and reviews code, configuration, and documentation in the current repository." },
  }),
  REPOSITORY_WRITE: capability({
    id: "REPOSITORY_WRITE",
    effects: ["repositoryWrite"],
    tools: [],
    actions: ["APPLY_PATCH"],
    surfaces: [],
    zh: { name: "仓库文件修改", description: "通过受控补丁创建或修改代码、配置和文档文件。", limitation: "只有用户提出落盘任务时才为该请求开放。" },
    en: { name: "Repository file changes", description: "Creates or modifies code, configuration, and documentation through controlled patches.", limitation: "Enabled only for requests that ask for repository changes." },
  }),
  COMMAND_EXECUTION: capability({
    id: "COMMAND_EXECUTION",
    effects: ["commandExecution", "verification"],
    tools: [],
    actions: ["RUN_COMMAND"],
    surfaces: [],
    zh: { name: "受控命令与验证", description: "运行受控命令完成测试、类型检查、构建和其他验证。" },
    en: { name: "Controlled commands and verification", description: "Runs controlled commands for tests, type checks, builds, and other verification." },
  }),
  KNOWLEDGE_RAG: capability({
    id: "KNOWLEDGE_RAG",
    effects: ["knowledgeEvidence"],
    tools: ["knowledge_index", "knowledge_search"],
    actions: [],
    surfaces: ["mini-agent rag"],
    zh: { name: "仓库文档 RAG", description: "Agent 可按需索引并查询仓库文本、源码与配置文档；候选证据返回前会检测源文件陈旧状态，并保留文件与行号引用。" },
    en: { name: "Repository document RAG", description: "Lets the Agent index and query repository text, source-code, and configuration documents, detects stale selected sources before returning evidence, and preserves file-and-line citations." },
  }),
  READ_ONLY_PLAN: capability({
    id: "READ_ONLY_PLAN",
    effects: ["readOnly"],
    tools: [],
    actions: ["PLAN"],
    surfaces: ["/plan", "/execute"],
    zh: { name: "只读规划", description: "调查仓库并生成实施计划，同时在运行时阻止补丁和命令。" },
    en: { name: "Read-only planning", description: "Investigates the repository and produces an implementation plan while blocking patches and commands." },
  }),
  MULTI_AGENT_COLLABORATION: capability({
    id: "MULTI_AGENT_COLLABORATION",
    effects: ["delegation", "changeProposal", "review"],
    tools: [],
    actions: ["DELEGATE", "APPLY_DELEGATED_PATCH"],
    surfaces: [],
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
  MCP_TOOL_RUNTIME: capability({
    id: "MCP_TOOL_RUNTIME",
    effects: ["mcp"],
    tools: [],
    actions: ["TOOL_CALL"],
    surfaces: ["mini-agent mcp tools", "mini-agent mcp status", "mini-agent mcp call"],
    zh: {
      name: "MCP 外部能力运行时",
      description: "分页发现配置的 MCP Server 工具，并为已发现的 resources 与 prompts 注册只读适配器；单项失败局部降级，所有能力均命名空间化并通过同一精确权限链调用。",
      limitation: "当前实现 2025-11-25 initialize/session 下的 tools、静态 resources/list/read 和 prompts/list/get 子集；不包含 resource templates、订阅、OAuth、服务端主动请求或更新协议的全部能力。",
    },
    en: {
      name: "MCP external-capability runtime",
      description: "Discovers paginated MCP tools and registers read-only adapters for discovered resources and prompts; individual capability failures degrade locally, and every capability is namespaced and invoked through the same exact permission chain.",
      limitation: "This implements the tools, static resources/list/read, and prompts/list/get subsets of the 2025-11-25 initialize/session shape, not resource templates, subscriptions, OAuth, server-initiated requests, or complete newer-protocol coverage.",
    },
  }),
  SESSION_PERSISTENCE: capability({
    id: "SESSION_PERSISTENCE",
    effects: ["sessionEvidence", "recovery"],
    tools: [],
    actions: [],
    surfaces: ["/resume", "/history", "/events", "/compact", "mini-agent session"],
    zh: {
      name: "会话持久化与恢复",
      description: "持久化会话消息、运行事件、检查点、任务摘要和任务级 Diff，并支持暂停、恢复和语义历史检索。",
      limitation: "面向本地单用户 CLI，不是多租户会话服务。",
    },
    en: {
      name: "Session persistence and recovery",
      description: "Persists messages, runtime events, checkpoints, task summaries, and task-level diffs, with pause, resume, and semantic history retrieval.",
      limitation: "This targets a local single-user CLI rather than a multi-tenant session service.",
    },
  }),
  LONG_TERM_MEMORY: capability({
    id: "LONG_TERM_MEMORY",
    effects: ["memoryEvidence"],
    tools: [],
    actions: [],
    surfaces: ["/memory", "/remember", "/forget", "mini-agent memory"],
    zh: {
      name: "本地长期记忆",
      description: "索引会话记忆，支持混合检索、显式写入与删除，并将选中的记忆作为不可信证据注入上下文。",
      limitation: "存储和检索针对本地项目，不提供跨设备同步或多用户 ACL。",
    },
    en: {
      name: "Local long-term memory",
      description: "Indexes session memories, supports hybrid retrieval and explicit remember/forget operations, and injects selected memories as untrusted evidence.",
      limitation: "Storage and retrieval are repository-local, without cross-device synchronization or multi-user ACLs.",
    },
  }),
  DECLARATIVE_SKILLS: capability({
    id: "DECLARATIVE_SKILLS",
    effects: ["skillContext"],
    tools: ["skill_read"],
    actions: [],
    surfaces: ["SKILL.md", "/skills", "mini-agent skill"],
    zh: {
      name: "声明式 Skills",
      description: "向模型暴露有界 Skill 目录，发现、校验和选择仓库或本地 SKILL.md，并通过 skill_read 渐进读取完整指令与随附文本资源。",
      limitation: "Skills 是声明式上下文能力，不是任意代码插件执行器或远程市场。",
    },
    en: {
      name: "Declarative skills",
      description: "Exposes a bounded catalog, validates and selects repository/local SKILL.md files, and progressively reads full instructions and bundled text resources through skill_read.",
      limitation: "Skills are declarative context, not an arbitrary-code plugin executor or remote marketplace.",
    },
  }),
  AGENT_EVALUATION: capability({
    id: "AGENT_EVALUATION",
    effects: ["evaluation"],
    tools: [],
    actions: [],
    surfaces: ["mini-agent bench run", "pnpm verify"],
    zh: {
      name: "AgentBench 评测",
      description: "运行版本化的确定性或真实模型场景，记录成功率、工具选择、步骤、Token 和回归门禁。",
      limitation: "真实模型统计仍取决于用户配置的模型、样本次数和外部服务可用性。",
    },
    en: {
      name: "AgentBench evaluation",
      description: "Runs versioned scripted or real-model scenarios and records success, tool choice, steps, tokens, and regression gates.",
      limitation: "Real-model statistics still depend on the configured model, sample count, and external service availability.",
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
      const surfaces = entry.surfaces.length > 0 ? ` surfaces=${entry.surfaces.join(",")}` : "";
      return `- ${entry.id}: supported=true; task-frame-effects=${entry.effects.join(",")};${tools}${actions}${surfaces} ${entry.en.description}`;
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
