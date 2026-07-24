import {
  looksLikeIndexedKnowledgeRequest as taskLooksLikeIndexedKnowledgeRequest,
  understandTask,
  type TaskUnderstanding,
} from "./TaskUnderstanding.js";

export type TaskIntent = "DIRECT_ANSWER" | "WEB_ANSWER" | "CODE_REVIEW" | "AGENT_LOOP";

export interface TaskRoute {
  intent: TaskIntent;
  reason: string;
  understanding?: TaskUnderstanding;
}

const DIRECT_SNIPPET_KEYWORDS = [
  "代码片段",
  "示例代码",
  "写一段",
  "snippet",
  "example code",
  "sample code",
];

const DIRECT_SNIPPET_ONLY_SIGNALS = [
  "不要改文件",
  "不改文件",
  "别改文件",
  "只要代码片段",
  "只要片段",
  "只给我代码",
  "snippet only",
  "without editing files",
  "do not edit files",
];

const CODE_CONTINUATION_TERMS = [
  "代码",
  "程序",
  "函数",
  "类",
  "接口",
  "模块",
  "组件",
  "脚本",
  "算法",
  "数据结构",
  "数据流",
  "页面",
  "服务",
  "工具",
  "code",
  "program",
  "function",
  "class",
  "interface",
  "module",
  "component",
  "script",
  "algorithm",
  "data structure",
  "data stream",
  "page",
  "service",
  "tool",
];

const CASUAL_DIRECT_REPLY_PHRASES = [
  "没事",
  "没事了",
  "没事我按错了",
  "没事按错了",
  "我按错了",
  "按错了",
  "我点错了",
  "点错了",
  "误触了",
  "不小心点错了",
  "算了",
  "不用了",
  "先这样",
  "先这样吧",
  "当我没说",
  "ignore that",
  "never mind",
  "nevermind",
  "wrong click",
  "misclick",
];

const WEB_SWITCH_CONFIRMATION_PHRASES = [
  "切换吧",
  "切到联网",
  "切换到联网",
  "联网查吧",
  "联网搜吧",
  "那就查吧",
  "那就搜吧",
  "用网页查吧",
  "你用搜一下",
  "用搜一下",
  "use web",
  "switch to web",
  "search online then",
];

const REPOSITORY_MUTATION_KEYWORDS = [
  "修改",
  "新增",
  "创建",
  "删除",
  "保存",
  "写入",
  "修复",
  "重构",
  "补丁",
  "patch",
  "fix",
  "refactor",
  "update",
  "change",
  "edit",
  "rewrite",
  "apply",
];

export function routeTask(userGoal: string, providedUnderstanding?: TaskUnderstanding): TaskRoute {
  const normalized = normalizeTask(userGoal);
  const understanding = providedUnderstanding ?? understandTask(userGoal);
  if (matchesCasualDirectReply(normalized)) {
    return route("DIRECT_ANSWER", "Casual conversational control message.", understanding);
  }
  if (looksLikeWebSwitchConfirmation(normalized)) {
    return route("WEB_ANSWER", "The user explicitly confirms using Web research.", {
      ...understanding,
      operation: "RESEARCH",
      target: "WORLD",
      explicitWeb: true,
      signals: [...understanding.signals, "web-switch-confirmation"],
    });
  }
  if (
    looksLikeExplicitSnippetRequest(normalized)
    && understanding.operation !== "REVIEW_REPOSITORY"
    && understanding.operation !== "ANALYZE_REPOSITORY"
  ) {
    return route("DIRECT_ANSWER", "The user explicitly requests chat-only code.", understanding);
  }

  switch (understanding.operation) {
    case "RESEARCH":
      return route("WEB_ANSWER", "Task understanding requires external evidence.", understanding);
    case "REVIEW_REPOSITORY":
      return route("CODE_REVIEW", "Task understanding identifies a repository review.", understanding);
    case "ANALYZE_REPOSITORY":
    case "CHANGE_REPOSITORY":
    case "QUERY_KNOWLEDGE":
      return route("AGENT_LOOP", `Task understanding selected ${understanding.operation}.`, understanding);
    case "ANSWER":
    case "LOCAL_STATE":
      return route("DIRECT_ANSWER", `Task understanding selected ${understanding.operation}.`, understanding);
  }
}

export function looksLikeWebSwitchConfirmation(normalized: string): boolean {
  return containsAny(normalized, WEB_SWITCH_CONFIRMATION_PHRASES);
}

export function looksLikeRepositoryAnalysisTask(userGoal: string): boolean {
  return understandTask(userGoal).operation === "ANALYZE_REPOSITORY";
}

export function looksLikeCodeContinuationFollowUp(userGoal: string): boolean {
  const normalized = normalizeTask(userGoal);
  if (normalized.length === 0 || normalized.startsWith("/")) {
    return false;
  }

  return containsAny(normalized, CODE_CONTINUATION_TERMS);
}

export function looksLikeRagCapabilityQuestion(value: string): boolean {
  const normalized = normalizeTask(value);
  const compact = normalized.replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  const mentionsRag = /\brag\b/i.test(normalized)
    || compact.includes("检索增强生成")
    || compact.includes("知识库");
  if (!mentionsRag) {
    return false;
  }

  const chineseSubject = "(?:(?:你|这个项目|本项目|这个cli|这个agent|该agent))?";
  const chineseTarget = "(?:rag(?:系统)?|知识库(?:系统)?|检索增强生成(?:系统)?)";
  return new RegExp(`^${chineseSubject}(?:有|有没有|是否有|支持|具备)${chineseTarget}(?:功能|能力)?(?:吗)?$`, "i").test(compact)
    || new RegExp(`^${chineseSubject}${chineseTarget}(?:能用|可以用|可用|支持吗|有吗)$`, "i").test(compact)
    || new RegExp(`^${chineseSubject}(?:能|可以)用${chineseTarget}(?:吗)?$`, "i").test(compact)
    || /^\s*(?:do|does)\s+(?:you|this (?:cli|project|agent))\s+(?:have|support)\s+(?:(?:a|an)\s+)?(?:rag(?:\s+system)?|knowledge\s+base)(?:\s+(?:feature|capability))?\s*[?.!]*$/i.test(value)
    || /^\s*is\s+there\s+(?:(?:a|an|any)\s+)?(?:rag(?:\s+system)?|knowledge\s+base)\s*[?.!]*$/i.test(value);
}

export function looksLikeIndexedKnowledgeRequest(value: string): boolean {
  return taskLooksLikeIndexedKnowledgeRequest(value);
}

export function looksLikeCacheResponsibilityQuestion(value: string): boolean {
  const normalized = normalizeTask(value);
  if (!/(?:缓存|\bcache\b|cached tokens?|kv cache|prompt cache)/i.test(normalized)) {
    return false;
  }

  const chineseOwnershipQuestion = /(?:谁|还是|是否|吗|[？?]|该不该|应该由|究竟)/.test(normalized)
    && (
      /(?:谁|模型|agent|代理|服务端).{0,16}(?:负责|该做|来做|职责|读写|命中)/i.test(normalized)
      || /(?:负责|该做|来做|职责|读写|命中).{0,16}(?:谁|模型|agent|代理|服务端)/i.test(normalized)
    );
  return chineseOwnershipQuestion
    || /\bwho\b[^?]{0,40}\b(?:owns?|handles?|manages?)\b[^?]{0,30}\bcach/i.test(normalized)
    || /(?:\?|\b(?:who|which|should|whether)\b)[^?]{0,80}\bcach[^?]{0,30}\b(?:model|agent|provider|server)\b[^?]{0,30}\b(?:responsib|own|handle|manage)/i.test(normalized);
}

function looksLikeExplicitSnippetRequest(normalized: string): boolean {
  if (containsAny(normalized, DIRECT_SNIPPET_ONLY_SIGNALS)) {
    return true;
  }

  return containsAny(normalized, DIRECT_SNIPPET_KEYWORDS)
    && !containsAny(normalized, REPOSITORY_MUTATION_KEYWORDS);
}

function normalizeTask(value: string): string {
  return value.trim().toLowerCase();
}

function matchesCasualDirectReply(value: string): boolean {
  const compact = value.replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  return CASUAL_DIRECT_REPLY_PHRASES.some((phrase) => compact === phrase);
}

function containsAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => containsKeyword(value, keyword));
}

function containsKeyword(value: string, keyword: string): boolean {
  if (/^[a-z][a-z0-9\s-]*$/i.test(keyword)) {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${escapedKeyword}($|[^a-z0-9])`, "i").test(value);
  }

  return value.includes(keyword);
}

function route(intent: TaskIntent, reason: string, understanding: TaskUnderstanding): TaskRoute {
  return { intent, reason, understanding };
}
