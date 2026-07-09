import { extractKeywords, unique } from "./MemoryText.js";

export type MemoryQueryIntent =
  | "CODE_TASK"
  | "CODE_REVIEW"
  | "ERROR_DIAGNOSIS"
  | "WEB_RESEARCH"
  | "CONVERSATION"
  | "GENERAL";

export interface MemoryQuery {
  originalQuery: string;
  normalizedQuery: string;
  expandedQuery: string;
  keywords: string[];
  entities: string[];
  intent: MemoryQueryIntent;
  preferredModes: string[];
  recencyBias: number;
  sameSessionBias: number;
  evidenceBudget: number;
  sessionId?: string;
  generatedAt: string;
}

export interface BuildMemoryQueryInput {
  query: string;
  sessionId?: string;
  recentMemory?: string;
}

const QUERY_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /写进去|保存|落盘|写入|创建文件|文件里面|save|write/i, terms: ["写入", "保存", "文件", "patch", "file_change"] },
  { pattern: /怎么运行|运行|启动|run|start/i, terms: ["运行", "启动", "命令", "script", "package"] },
  { pattern: /报错|错误|失败|error|failed|exception|enoent|cannot find/i, terms: ["错误", "失败", "诊断", "修复", "command_result"] },
  { pattern: /审查|检查.*bug|review|bug/i, terms: ["代码审查", "bug", "finding", "verification"] },
  { pattern: /联网|最新|今天|实时|新闻|比分|股市|汇率|latest|current/i, terms: ["联网", "搜索", "来源", "web_search", "fetch_url"] },
  { pattern: /记得|之前|上次|刚才|历史|memory|session/i, terms: ["记忆", "历史", "session", "summary"] },
];

export function buildMemoryQuery(input: BuildMemoryQueryInput): MemoryQuery {
  const originalQuery = input.query.trim();
  const normalizedQuery = normalizeQuery(originalQuery);
  const intent = inferMemoryQueryIntent(normalizedQuery);
  const preferredModes = inferPreferredModes(intent, normalizedQuery);
  const expansions = QUERY_EXPANSIONS
    .filter((item) => item.pattern.test(normalizedQuery))
    .flatMap((item) => item.terms);
  const recentContextTerms = input.recentMemory
    ? extractKeywords(input.recentMemory).slice(0, 12)
    : [];
  const keywords = unique([
    ...extractKeywords(normalizedQuery),
    ...extractKeywords(expansions.join(" ")),
    ...recentContextTerms.slice(0, 16),
  ]);
  const entities = extractEntities(originalQuery, keywords);
  const expandedQuery = unique([
    normalizedQuery,
    ...entities,
    ...expansions,
    ...preferredModes,
  ].filter((item) => item.trim().length > 0)).join(" ");

  return {
    originalQuery,
    normalizedQuery,
    expandedQuery,
    keywords,
    entities,
    intent,
    preferredModes,
    recencyBias: inferRecencyBias(intent, normalizedQuery),
    sameSessionBias: input.sessionId ? 1 : 0,
    evidenceBudget: inferEvidenceBudget(intent),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    generatedAt: new Date().toISOString(),
  };
}

function normalizeQuery(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function inferMemoryQueryIntent(query: string): MemoryQueryIntent {
  if (/写进去|保存|落盘|写入|创建文件|文件里面|save|write/.test(query)) {
    return "CODE_TASK";
  }
  if (/审查|检查.*bug|review|code review/.test(query)) {
    return "CODE_REVIEW";
  }
  if (/报错|错误|失败|exception|error|failed|cannot find|enoent|eaddrinuse|econnrefused/.test(query)) {
    return "ERROR_DIAGNOSIS";
  }
  if (/联网|最新|今天|实时|新闻|比分|股市|行情|汇率|latest|current|news/.test(query)) {
    return "WEB_RESEARCH";
  }
  if (/记得|之前|上次|刚才|历史|memory|session|聊了什么/.test(query)) {
    return "CONVERSATION";
  }
  if (/写|实现|修复|创建|保存|落盘|测试|运行|代码|函数|类|demo|game|算法|中位数|括号|数组|链表|堆|栈|二叉树|排序|查找|file|patch|run/.test(query)) {
    return "CODE_TASK";
  }
  return "GENERAL";
}

function inferPreferredModes(intent: MemoryQueryIntent, query: string): string[] {
  switch (intent) {
    case "CODE_TASK":
      return ["AGENT_LOOP"];
    case "CODE_REVIEW":
      return ["CODE_REVIEW", "AGENT_LOOP"];
    case "ERROR_DIAGNOSIS":
      return ["DIRECT_ANSWER", "AGENT_LOOP"];
    case "WEB_RESEARCH":
      return ["WEB_ANSWER"];
    case "CONVERSATION":
      return ["DIRECT_ANSWER", "WEB_ANSWER", "AGENT_LOOP"];
    case "GENERAL":
      return /怎么运行|运行|启动|run/.test(query) ? ["AGENT_LOOP"] : [];
    default:
      return [];
  }
}

function inferRecencyBias(intent: MemoryQueryIntent, query: string): number {
  if (/刚才|最近|latest|current|今天|上次|previous|last/.test(query)) {
    return 1;
  }
  if (intent === "WEB_RESEARCH" || intent === "ERROR_DIAGNOSIS") {
    return 0.75;
  }
  if (intent === "CONVERSATION") {
    return 0.65;
  }
  return 0.35;
}

function inferEvidenceBudget(intent: MemoryQueryIntent): number {
  switch (intent) {
    case "CODE_REVIEW":
    case "ERROR_DIAGNOSIS":
      return 6;
    case "CODE_TASK":
    case "WEB_RESEARCH":
      return 5;
    default:
      return 4;
  }
}

function extractEntities(originalQuery: string, keywords: string[]): string[] {
  const asciiEntities = originalQuery.match(/\b[A-Z][A-Za-z0-9_]{1,}\b|\b[a-zA-Z_][a-zA-Z0-9_]*\.(?:ts|js|java|cpp|py|html|md)\b/g) ?? [];
  const quoted = [...originalQuery.matchAll(/[`"'“”](.*?)[`"'“”]/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 1);
  const compactChinese = keywords
    .filter((keyword) => /[\u3400-\u9fff]/.test(keyword) && keyword.length >= 3 && keyword.length <= 10)
    .slice(0, 10);

  return unique([...asciiEntities, ...quoted, ...compactChinese]);
}
