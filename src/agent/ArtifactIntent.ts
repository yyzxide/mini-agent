const DOCUMENT_ACTION_KEYWORDS = [
  "写一个",
  "写一份",
  "写一篇",
  "写份",
  "写个",
  "编写",
  "撰写",
  "起草",
  "创建",
  "新建",
  "生成",
  "整理成",
  "write a",
  "write an",
  "create a",
  "create an",
  "draft a",
  "draft an",
  "generate a",
  "generate an",
];

const DOCUMENT_TARGET_KEYWORDS = [
  "文档",
  "说明书",
  "报告",
  "指南",
  "手册",
  "readme",
  "design doc",
  "design document",
  "architecture doc",
  "architecture document",
  "documentation",
  "specification",
  "technical report",
  "user guide",
  "manual",
];

const CHAT_ONLY_PATTERNS = [
  /不要(?:修改|写入|创建|新建).{0,8}文件/i,
  /(?:不改|别改|不要改)文件/i,
  /只(?:在)?(?:聊天|对话|这里|窗口)(?:里|中)?(?:展示|输出|回答|给我)/i,
  /(?:直接|只)(?:展示|输出)(?:内容)?(?:就行|即可)?/i,
  /(?:do not|don't) (?:edit|modify|write|create) (?:a |the )?files?/i,
  /without (?:editing|modifying|writing|creating) (?:a |the )?files?/i,
  /chat[- ]only/i,
];

const HOW_TO_PATTERNS = [
  /(?:如何|怎么|怎样).{0,12}(?:写|编写|撰写|起草|创建|制作).{0,12}(?:文档|说明书|报告|指南|手册)/i,
  /\bhow\s+(?:(?:do|can|should|would)\s+[^?]{0,40}|to\s+)\b(?:write|create|draft)\b[^?]{0,40}\b(?:document|documentation|readme|report|guide|manual)\b/i,
];

const DOCUMENT_ACTION_PATTERNS = [
  /^(?:请|麻烦)?(?:帮我|给我|替我)?(?:写|编写|撰写|起草|创建|新建|生成)/i,
  /(?:帮我|给我|替我|请|麻烦).{0,8}(?:写|编写|撰写|起草|创建|新建|生成)/i,
  /\b(?:write|create|draft|generate)\b/i,
];

const NON_DOCUMENT_ARTIFACT_PATTERNS = [
  /(?:文档|报告|readme)\s*(?:的)?\s*(?:导出|解析|读取|编辑|渲染|生成)(?:功能|器|组件|接口|服务|工具)/i,
  /\b(?:documentation|document|report|readme)\s+(?:exporter|parser|reader|editor|renderer|generator|component|service|tool)\b/i,
];

export function mentionsDocumentArtifact(userGoal: string): boolean {
  const normalized = userGoal.trim().toLowerCase();
  return DOCUMENT_TARGET_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function hasExplicitChatOnlyConstraint(userGoal: string): boolean {
  return CHAT_ONLY_PATTERNS.some((pattern) => pattern.test(userGoal));
}

export function looksLikeDocumentCreationTask(userGoal: string): boolean {
  const normalized = userGoal.trim().toLowerCase();
  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (!mentionsDocumentArtifact(normalized)) {
    return false;
  }

  if (hasExplicitChatOnlyConstraint(userGoal)) {
    return false;
  }

  if (HOW_TO_PATTERNS.some((pattern) => pattern.test(userGoal))) {
    return false;
  }

  if (NON_DOCUMENT_ARTIFACT_PATTERNS.some((pattern) => pattern.test(userGoal))) {
    return false;
  }

  return DOCUMENT_ACTION_KEYWORDS.some((keyword) => normalized.includes(keyword))
    || DOCUMENT_ACTION_PATTERNS.some((pattern) => pattern.test(userGoal));
}
