import { hasHighConfidenceDiagnostic } from "../diagnostics/ErrorClassifier.js";
import { extractLikelyReviewFilePath, looksLikeReviewableFilePath } from "../review/CodeReview.js";
import { looksLikeFileWriteConfirmation, looksLikeSaveToFileFollowUp } from "./TaskFollowUp.js";

export type TaskIntent = "DIRECT_ANSWER" | "WEB_ANSWER" | "CODE_REVIEW" | "AGENT_LOOP";

export interface TaskRoute {
  intent: TaskIntent;
  reason: string;
}

const REPOSITORY_KEYWORDS = [
  "仓库",
  "项目",
  "文件",
  "目录",
  "当前仓库",
  "当前项目",
  "当前目录",
  "当前文件",
  "这里的仓库",
  "这里的项目",
  "这个 repo",
  "这个代码",
  "修改",
  "新增",
  "创建",
  "删除",
  "保存",
  "写入",
  "补充",
  "修复",
  "重构",
  "测试",
  "readme",
  "src/",
  ".ts",
  ".js",
  ".java",
  ".go",
  ".py",
  ".cpp",
  "repo",
  "repository",
  "project",
  "file",
  "directory",
  "modify",
  "add",
  "create",
  "delete",
  "fix",
  "refactor",
  "test",
];

const REPOSITORY_ACTION_KEYWORDS = [
  "仓库",
  "项目",
  "文件",
  "目录",
  "当前仓库",
  "当前项目",
  "当前目录",
  "当前文件",
  "这里的仓库",
  "这里的项目",
  "这个 repo",
  "这个代码",
  "修改",
  "新增",
  "创建",
  "删除",
  "保存",
  "写入",
  "补充",
  "修复",
  "重构",
  "测试",
  "readme",
  "src/",
  "repo",
  "repository",
  "project",
  "file",
  "directory",
  "modify",
  "add",
  "create",
  "delete",
  "fix",
  "refactor",
  "test",
];

const DIRECT_SNIPPET_KEYWORDS = [
  "代码片段",
  "示例代码",
  "写一段",
  "two sum",
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

const CODE_GENERATION_ACTION_KEYWORDS = [
  "写个",
  "写一个",
  "帮我写个",
  "做个",
  "做一个",
  "实现一个",
  "实现下",
  "生成一个",
  "创建一个",
  "build a",
  "create a",
  "write a",
  "implement a",
];

const CODE_GENERATION_TARGET_KEYWORDS = [
  "代码",
  "程序",
  "游戏",
  "页面",
  "脚本",
  "组件",
  "服务",
  "接口",
  "工具",
  "2048",
  "c++",
  "cpp",
  "python",
  "java",
  "go",
  "rust",
  "html",
  "css",
  "javascript",
  "typescript",
  "node",
  "react",
  "vue",
  "前端",
  "后端",
  "算法题",
];

const ALGORITHM_PROBLEM_KEYWORDS = [
  "算法",
  "题",
  "括号",
  "数组",
  "链表",
  "二叉树",
  "字符串",
  "回文",
  "最长",
  "中位数",
  "数据流",
  "堆",
  "最短",
  "子串",
  "子序列",
  "动态规划",
  "贪心",
  "滑动窗口",
  "哈希",
  "栈",
  "队列",
  "图",
  "树",
  "dfs",
  "bfs",
  "dp",
  "leetcode",
];

const QUESTION_KEYWORDS = [
  "你是谁",
  "知道",
  "知道吗",
  "是谁",
  "是什么",
  "为什么",
  "怎么",
  "如何",
  "哪里",
  "哪个",
  "哪支",
  "哪位",
  "哪一年",
  "哪年",
  "多少",
  "吗",
  "？",
  "?",
  "解释",
  "说明",
  "记得",
  "还记得",
  "刚才",
  "上次",
  "之前",
  "现在呢",
  "我们聊",
  "我们说",
  "what is",
  "who are you",
  "who is",
  "why",
  "how to",
  "where",
  "when",
  "which",
  "how many",
  "explain",
  "remember",
  "previous",
  "last time",
  "what did we discuss",
];

const SHORT_CHAT_EXCLUSION_KEYWORDS = [
  "仓库",
  "项目",
  "文件",
  "目录",
  "代码",
  "编程",
  "函数",
  "类",
  "接口",
  "bug",
  "debug",
  "fix",
  "patch",
  "review",
  "测试",
  "命令",
  "运行",
  "编译",
  "构建",
  "部署",
  "脚本",
  "程序",
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

const WEB_RESEARCH_KEYWORDS = [
  "联网",
  "网上",
  "搜索一下",
  "查一下",
  "查找",
  "资料",
  "最新",
  "最近",
  "新闻",
  "网址",
  "网页",
  "来源",
  "资料来源",
  "比分",
  "赛果",
  "赛程",
  "成绩",
  "战绩",
  "排名",
  "冠军",
  "夺冠",
  "夺得",
  "获得冠军",
  "夺冠了",
  "世界杯",
  "大师赛",
  "比赛结果",
  "股市",
  "股票",
  "a股",
  "A股",
  "大盘",
  "指数",
  "上证",
  "深证",
  "创业板",
  "沪深",
  "收盘",
  "开盘",
  "涨跌",
  "涨幅",
  "跌幅",
  "行情",
  "证券",
  "金融市场",
  "汇率",
  "价格",
  "search the web",
  "web search",
  "look up",
  "browse",
  "latest",
  "recent",
  "news",
  "source",
  "score",
  "scores",
  "result",
  "results",
  "standings",
  "champion",
  "world cup",
  "stock",
  "stocks",
  "stock market",
  "market index",
  "indices",
  "index",
  "closing price",
  "market close",
  "exchange rate",
  "price",
];

const CODE_REVIEW_KEYWORDS = [
  "检查",
  "审查",
  "review",
  "code review",
  "看看",
  "排查",
  "bug",
  "bugs",
  "问题",
  "缺陷",
  "隐患",
  "有没有 bug",
  "是否存在bug",
  "check this file",
  "inspect this file",
  "review this file",
];

const FILE_CONTEXT_KEYWORDS = [
  "文件",
  "代码",
  "当前文件",
  "这个文件",
  "打开文件",
  "source file",
  "file",
  "code",
];

const REPOSITORY_ANALYSIS_KEYWORDS = [
  "分析",
  "总结",
  "概括",
  "介绍",
  "看看项目",
  "项目分析",
  "项目结构",
  "仓库结构",
  "模块职责",
  "模块结构",
  "当前文件夹的项目",
  "当前项目",
  "当前仓库",
  "explain this repository",
  "analyze this repository",
  "analyze the repository",
  "summarize this repository",
  "repository overview",
  "project overview",
  "explain this project",
  "summarize modules",
  "analyze the project",
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

export function routeTask(userGoal: string): TaskRoute {
  const normalized = normalizeTask(userGoal);
  const needsWeb = containsAny(normalized, WEB_RESEARCH_KEYWORDS);
  const reviewTarget = extractLikelyReviewFilePath(userGoal);
  const reviewRequest = containsAny(normalized, CODE_REVIEW_KEYWORDS)
    && (containsAny(normalized, FILE_CONTEXT_KEYWORDS) || reviewTarget !== undefined || normalized.includes("当前") || normalized.includes("打开"));

  if (matchesCasualDirectReply(normalized)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task looks like a casual acknowledgement, cancellation, or mis-click style message.",
    };
  }

  if (looksLikeFileWriteConfirmation(userGoal)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task asks whether a previous file write actually happened, which should be answered from local session state.",
    };
  }

  if (hasHighConfidenceDiagnostic({ text: userGoal, repoPath: "." })) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task includes a recognizable runtime error that should be diagnosed locally before asking the model.",
    };
  }

  if (looksLikeWebCapabilityQuestion(normalized)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task asks about the CLI's web capability, which should be answered from local product knowledge.",
    };
  }

  if (looksLikeSaveToFileFollowUp(userGoal)) {
    return {
      intent: "AGENT_LOOP",
      reason: "Task asks to save previously generated code into repository files.",
    };
  }

  if (looksLikeReviewableFilePath(userGoal.trim())) {
    return {
      intent: "CODE_REVIEW",
      reason: "Input looks like a repository file path, so default to a file review flow.",
    };
  }

  if (reviewRequest) {
    return {
      intent: "CODE_REVIEW",
      reason: "Task appears to request a file-focused code review or bug inspection.",
    };
  }

  if (needsWeb && !containsAny(normalized, REPOSITORY_ACTION_KEYWORDS)) {
    return {
      intent: "WEB_ANSWER",
      reason: "Task appears to require current or external web information.",
    };
  }

  if (looksLikeExplicitSnippetRequest(normalized)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task explicitly asks for a code snippet without repository edits.",
    };
  }

  if (looksLikeStandaloneCodeGenerationTask(normalized, userGoal)) {
    return {
      intent: "AGENT_LOOP",
      reason: "Task looks like a request to implement code in repository files rather than only chat about code.",
    };
  }

  if (containsAny(normalized, REPOSITORY_KEYWORDS)) {
    return {
      intent: "AGENT_LOOP",
      reason: "Task appears to reference repository files or requests a repository change.",
    };
  }

  if (containsAny(normalized, DIRECT_SNIPPET_KEYWORDS)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task looks like a standalone code snippet request.",
    };
  }

  if (needsWeb) {
    return {
      intent: "WEB_ANSWER",
      reason: "Task appears to require current or external web information.",
    };
  }

  if (containsAny(normalized, QUESTION_KEYWORDS)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Task looks like a general question rather than a repository edit.",
    };
  }

  if (looksLikeShortPlainChat(normalized, userGoal)) {
    return {
      intent: "DIRECT_ANSWER",
      reason: "Short plain-text input is safer to handle as normal conversation than as a repository edit.",
    };
  }

  return {
    intent: "AGENT_LOOP",
    reason: "Defaulting to repository agent loop for ambiguous coding tasks.",
  };
}

export function looksLikeRepositoryAnalysisTask(userGoal: string): boolean {
  const normalized = normalizeTask(userGoal);
  if (!containsAny(normalized, REPOSITORY_KEYWORDS)) {
    return false;
  }

  if (!containsAny(normalized, REPOSITORY_ANALYSIS_KEYWORDS)) {
    return false;
  }

  return !containsAny(normalized, REPOSITORY_MUTATION_KEYWORDS);
}

export function shouldPreserveAgentLoopIntent(userGoal: string): boolean {
  const normalized = normalizeTask(userGoal);
  return looksLikeStandaloneCodeGenerationTask(normalized, userGoal)
    || looksLikeCodeContinuationFollowUp(normalized)
    || looksLikeSaveToFileFollowUp(userGoal)
    || containsAny(normalized, REPOSITORY_ACTION_KEYWORDS)
    || looksLikeRepositoryAnalysisTask(userGoal);
}

export function looksLikeCodeContinuationFollowUp(userGoal: string): boolean {
  const normalized = normalizeTask(userGoal);
  if (normalized.length === 0 || normalized.startsWith("/")) {
    return false;
  }

  return containsAny(normalized, ALGORITHM_PROBLEM_KEYWORDS)
    || containsAny(normalized, CODE_GENERATION_TARGET_KEYWORDS);
}

export function looksLikeWebCapabilityQuestion(normalized: string): boolean {
  const compact = normalized.replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  return [
    "你不能联网吗",
    "你能联网吗",
    "你可以联网吗",
    "能联网吗",
    "可以联网吗",
    "有没有联网能力",
    "有联网能力吗",
    "不能联网吗",
    "不能上网吗",
    "能上网吗",
    "可以上网吗",
    "能访问网页吗",
    "可以访问网页吗",
  ].some((phrase) => compact.includes(phrase))
    || /\b(can|could)\s+you\s+(access\s+the\s+internet|browse|search\s+the\s+web)\b/i.test(normalized)
    || /\bdo\s+you\s+have\s+(web|internet|browsing)\s+(access|capability)\b/i.test(normalized);
}

function looksLikeShortPlainChat(normalized: string, userGoal: string): boolean {
  const trimmed = userGoal.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return false;
  }

  if (containsAny(normalized, SHORT_CHAT_EXCLUSION_KEYWORDS)) {
    return false;
  }

  if (/[{}[\];=<>]/.test(trimmed)) {
    return false;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return true;
  }

  return tokens.length <= 3 && trimmed.length <= 32;
}

function looksLikeStandaloneCodeGenerationTask(normalized: string, userGoal: string): boolean {
  const trimmed = userGoal.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return false;
  }

  if (containsAny(normalized, DIRECT_SNIPPET_KEYWORDS)) {
    return false;
  }

  const hasAction = containsAny(normalized, CODE_GENERATION_ACTION_KEYWORDS);
  if (!hasAction) {
    return false;
  }

  const hasTarget = containsAny(normalized, CODE_GENERATION_TARGET_KEYWORDS)
    || containsAny(normalized, ALGORITHM_PROBLEM_KEYWORDS)
    || /\b(c\+\+|cpp|python|java|go|rust|html|css|javascript|typescript|node|react|vue)\b/i.test(userGoal)
    || /\.(ts|js|jsx|tsx|java|go|py|cpp|c|cc|html|css|sh)\b/i.test(userGoal);

  return hasTarget;
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
  return CASUAL_DIRECT_REPLY_PHRASES.some((phrase) => compact.includes(phrase));
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
