export type ProductCapabilityId =
  | "DIRECT_RESPONSE"
  | "WEB_RESEARCH"
  | "REPOSITORY_READ"
  | "REPOSITORY_WRITE"
  | "COMMAND_EXECUTION"
  | "KNOWLEDGE_RAG"
  | "READ_ONLY_PLAN";

export interface ProductCapabilityDefinition {
  id: ProductCapabilityId;
  supported: true;
  contracts: string[];
  tools: string[];
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
  DIRECT_RESPONSE: capability({
    id: "DIRECT_RESPONSE",
    contracts: ["DIRECT_RESPONSE"],
    tools: [],
    zh: { name: "直接回答", description: "回答一般问题、解释概念、翻译和讨论代码，不需要启用仓库或网络工具。" },
    en: { name: "Direct answers", description: "Answers general questions, explains concepts, translates text, and discusses code without repository or network tools." },
  }),
  WEB_RESEARCH: capability({
    id: "WEB_RESEARCH",
    contracts: ["WEB_RESEARCH", "REPOSITORY_TASK"],
    tools: ["web_search", "fetch_url"],
    zh: { name: "受控联网研究", description: "搜索公开网页并抓取公网 HTTP(S) 页面文本。", limitation: "不是常驻浏览器；实时结论仍受可访问来源和证据质量限制。" },
    en: { name: "Controlled web research", description: "Searches public web results and fetches text from public HTTP(S) pages.", limitation: "This is not a persistent browser; live answers still depend on accessible, sufficient sources." },
  }),
  REPOSITORY_READ: capability({
    id: "REPOSITORY_READ",
    contracts: ["REPOSITORY_INVESTIGATION", "REPOSITORY_TASK"],
    tools: ["list_files", "read_file", "search_code", "git_status", "git_diff"],
    zh: { name: "仓库读取与分析", description: "读取、搜索、分析和审查当前仓库的代码、配置与文档。" },
    en: { name: "Repository reading and analysis", description: "Reads, searches, analyzes, and reviews code, configuration, and documentation in the current repository." },
  }),
  REPOSITORY_WRITE: capability({
    id: "REPOSITORY_WRITE",
    contracts: ["REPOSITORY_TASK"],
    tools: ["apply_patch"],
    zh: { name: "仓库文件修改", description: "通过受控补丁创建或修改代码、配置和文档文件。", limitation: "只有用户提出落盘任务时才为该请求开放。" },
    en: { name: "Repository file changes", description: "Creates or modifies code, configuration, and documentation through controlled patches.", limitation: "Enabled only for requests that ask for repository changes." },
  }),
  COMMAND_EXECUTION: capability({
    id: "COMMAND_EXECUTION",
    contracts: ["REPOSITORY_TASK"],
    tools: ["run_command"],
    zh: { name: "受控命令与验证", description: "运行受控命令完成测试、类型检查、构建和其他验证。" },
    en: { name: "Controlled commands and verification", description: "Runs controlled commands for tests, type checks, builds, and other verification." },
  }),
  KNOWLEDGE_RAG: capability({
    id: "KNOWLEDGE_RAG",
    contracts: ["KNOWLEDGE_QUERY", "REPOSITORY_TASK"],
    tools: ["knowledge_search"],
    zh: { name: "仓库文档 RAG", description: "查询已索引的仓库 Markdown/TXT 文档，并保留文件与行号引用。" },
    en: { name: "Repository document RAG", description: "Queries indexed repository Markdown/TXT documents and preserves file-and-line citations." },
  }),
  READ_ONLY_PLAN: capability({
    id: "READ_ONLY_PLAN",
    contracts: ["PLAN"],
    tools: [],
    zh: { name: "只读规划", description: "调查仓库并生成实施计划，同时在运行时阻止补丁和命令。" },
    en: { name: "Read-only planning", description: "Investigates the repository and produces an implementation plan while blocking patches and commands." },
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
      return `- ${entry.id}: supported=true; contracts=${entry.contracts.join(",")};${tools} ${entry.en.description}`;
    }),
    "TaskContract capabilities are per-request least-privilege boundaries. A capability disabled for the current request is not absent from the overall product.",
  ].join("\n");
}

function capability(
  input: Omit<ProductCapabilityDefinition, "supported">,
): ProductCapabilityDefinition {
  return { ...input, supported: true };
}
