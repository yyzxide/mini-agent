import type { SessionRecord } from "../session/SessionTypes.js";

export interface RepositoryFollowUpResolution {
  resolvedGoal: string;
  detectedLanguage?: string;
  sourceUserGoal?: string;
}

interface CodeArtifact {
  code: string;
  language?: string;
  blockCount: number;
  sourceUserGoal?: string;
}

const SAVE_TO_FILE_PATTERNS = [
  /(写入|保存|存到|放到|写进|落到).*(文件|file)/i,
  /(创建|新建).*(文件|file).*(写入|保存|存放)/i,
  /^(写进去|写进来|写入|保存|存一下|保存一下|落盘|放进去|放到文件|写进文件|写到文件)(吧|一下|呀|啊|嘛|吗|了)?$/i,
  /^(也|把它|把这个|把刚才的|刚才的|上面的|这段|这个代码).*(写进去|写进文件|写到文件|保存|落盘|放到文件)/i,
  /^(?:把|将).{1,60}(?:写进去|写入|保存|落盘|放进文件|写到文件)/i,
  /(save|write|put).*(into|to).*(file)/i,
  /(save|write).*(code).*(file)/i,
];

const FILE_WRITE_CONFIRMATION_PATTERNS = [
  /(写入|保存|写进|写到|落盘|创建|新建|改|修改).*(了吗|了嘛|没|没有|成功了吗|好了嘛|好了没)/i,
  /^(你)?(写入|保存|写进去|创建|新建|改好|修改)(了)?(吗|嘛|没|没有)$/i,
  /^(did you|have you).*(write|save|create|modify)/i,
];

export function resolveRepositoryFollowUpTask(
  userGoal: string,
  records: SessionRecord[],
): RepositoryFollowUpResolution | undefined {
  if (!looksLikeSaveToFileFollowUp(userGoal)) {
    return undefined;
  }

  const artifact = findLatestCodeArtifact(records);
  if (!artifact) {
    return undefined;
  }

  const languageLabel = artifact.language ? `${artifact.language} ` : "";
  const fence = artifact.language ? normalizeFenceLanguage(artifact.language) : "";
  const guidance = artifact.blockCount > 1
    ? "上一轮回答里包含多段代码，请优先把第一段主实现写入文件，不要把解释文字、重复实现或演示输出整段落盘。"
    : "请只把纯代码内容写入文件，不要把解释文字一起写进去。";

  const resolvedGoal = [
    `请把上一轮已经生成的 ${languageLabel}代码真正写入仓库文件，而不是继续只在对话里展示。`,
    artifact.sourceUserGoal ? `上一轮原始需求：${artifact.sourceUserGoal}` : undefined,
    artifact.language ? `检测到的代码语言：${artifact.language}` : undefined,
    guidance,
    "如果仓库里没有现成文件，请根据仓库结构创建一个新的合理文件，并使用匹配的扩展名。",
    "需要落盘的代码如下：",
    ["```" + fence, artifact.code, "```"].join("\n"),
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");

  return {
    resolvedGoal,
    ...(artifact.language ? { detectedLanguage: artifact.language } : {}),
    ...(artifact.sourceUserGoal ? { sourceUserGoal: artifact.sourceUserGoal } : {}),
  };
}

export function looksLikeSaveToFileFollowUp(userGoal: string): boolean {
  const normalized = normalizeSpaces(userGoal);
  if (normalized.length === 0 || normalized.startsWith("/")) {
    return false;
  }

  if (looksLikeFileWriteConfirmation(userGoal)) {
    return false;
  }

  return SAVE_TO_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function looksLikeFileWriteConfirmation(userGoal: string): boolean {
  const normalized = normalizeSpaces(userGoal);
  if (normalized.length === 0 || normalized.startsWith("/")) {
    return false;
  }

  return FILE_WRITE_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findLatestCodeArtifact(records: SessionRecord[]): CodeArtifact | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) {
      continue;
    }

    if (record.type !== "ASSISTANT_MESSAGE" && record.type !== "TASK_SUMMARY") {
      continue;
    }

    const text = readRecordText(record);
    if (!text) {
      continue;
    }

    const codeBlocks = extractCodeBlocks(text);
    if (codeBlocks.length === 0) {
      continue;
    }

    const preferredBlock = codeBlocks[0];
    if (!preferredBlock) {
      continue;
    }

    const sourceUserGoal = findPreviousUserMessage(records, index);

    return {
      code: preferredBlock.code,
      blockCount: codeBlocks.length,
      ...(preferredBlock.language ? { language: preferredBlock.language } : {}),
      ...(sourceUserGoal ? { sourceUserGoal } : {}),
    };
  }

  return undefined;
}

function readRecordText(record: SessionRecord): string | undefined {
  const payload = record.payload;
  const candidate = record.type === "TASK_SUMMARY" ? payload.summary : payload.content;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function extractCodeBlocks(text: string): Array<{ language?: string; code: string }> {
  const matches = [...text.matchAll(/```([A-Za-z0-9#+-]*)\n([\s\S]*?)```/g)];
  return matches
    .map((match) => {
      const language = normalizeLanguage(match[1] ?? "");
      return {
        code: match[2]?.trimEnd() ?? "",
        ...(language ? { language } : {}),
      };
    })
    .filter((block) => block.code.trim().length > 0);
}

function findPreviousUserMessage(records: SessionRecord[], startIndex: number): string | undefined {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) {
      continue;
    }

    if (record.type !== "USER_MESSAGE") {
      continue;
    }

    const content = record.payload.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }
  }

  return undefined;
}

function normalizeLanguage(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "py":
    case "python":
      return "Python";
    case "ts":
    case "typescript":
      return "TypeScript";
    case "js":
    case "javascript":
      return "JavaScript";
    case "cpp":
    case "c++":
    case "cc":
      return "C++";
    case "java":
      return "Java";
    case "go":
    case "golang":
      return "Go";
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "rs":
    case "rust":
      return "Rust";
    default:
      return value.trim();
  }
}

function normalizeFenceLanguage(language: string): string {
  switch (language) {
    case "TypeScript":
      return "ts";
    case "JavaScript":
      return "js";
    case "Python":
      return "python";
    case "C++":
      return "cpp";
    case "Go":
      return "go";
    case "Java":
      return "java";
    case "HTML":
      return "html";
    case "CSS":
      return "css";
    case "Rust":
      return "rust";
    default:
      return language.toLowerCase();
  }
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
