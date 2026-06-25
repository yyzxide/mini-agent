export type TaskIntent = "DIRECT_ANSWER" | "WEB_ANSWER" | "AGENT_LOOP";

export interface TaskRoute {
  intent: TaskIntent;
  reason: string;
}

const REPOSITORY_KEYWORDS = [
  "仓库",
  "项目",
  "文件",
  "目录",
  "当前",
  "这里",
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
  "当前",
  "这里",
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

const DIRECT_CODE_KEYWORDS = [
  "代码片段",
  "示例代码",
  "写一段",
  "写一个",
  "给我一个",
  "实现一个",
  "leetcode",
  "算法",
  "两数之和",
  "two sum",
  "snippet",
  "example code",
  "write a",
  "implement a",
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
];

export function routeTask(userGoal: string): TaskRoute {
  const normalized = normalizeTask(userGoal);
  const needsWeb = containsAny(normalized, WEB_RESEARCH_KEYWORDS);

  if (needsWeb && !containsAny(normalized, REPOSITORY_ACTION_KEYWORDS)) {
    return {
      intent: "WEB_ANSWER",
      reason: "Task appears to require current or external web information.",
    };
  }

  if (containsAny(normalized, REPOSITORY_KEYWORDS)) {
    return {
      intent: "AGENT_LOOP",
      reason: "Task appears to reference repository files or requests a repository change.",
    };
  }

  if (containsAny(normalized, DIRECT_CODE_KEYWORDS)) {
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

  return {
    intent: "AGENT_LOOP",
    reason: "Defaulting to repository agent loop for ambiguous coding tasks.",
  };
}

function normalizeTask(value: string): string {
  return value.trim().toLowerCase();
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
