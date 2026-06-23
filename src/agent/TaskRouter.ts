export type TaskIntent = "DIRECT_ANSWER" | "AGENT_LOOP";

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
  "是什么",
  "为什么",
  "怎么",
  "如何",
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
  "why",
  "how to",
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
  "新闻",
  "网址",
  "网页",
  "来源",
  "资料来源",
  "search the web",
  "web search",
  "look up",
  "browse",
  "latest",
  "news",
  "source",
];

export function routeTask(userGoal: string): TaskRoute {
  const normalized = normalizeTask(userGoal);

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

  if (containsAny(normalized, WEB_RESEARCH_KEYWORDS)) {
    return {
      intent: "AGENT_LOOP",
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
  return keywords.some((keyword) => value.includes(keyword));
}
