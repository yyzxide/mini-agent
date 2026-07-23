import path from "node:path";
import { existsSync } from "node:fs";
import type { JsonObject, SessionRecord } from "../session/SessionTypes.js";

export type ArtifactFollowUpIntent = "LOCATION" | "OPEN" | "LIST";
export type ArtifactChangeType = "ADDED" | "MODIFIED" | "DELETED";

export interface ResolvedArtifact {
  relativePath: string;
  absolutePath: string;
  changeType: ArtifactChangeType;
  exists: boolean;
}

export interface ArtifactFollowUpResolution {
  intent: ArtifactFollowUpIntent;
  source: "FILE_CHANGE";
  files: ResolvedArtifact[];
  answer: string;
}

const AGENT_LOCATION_PATTERNS = [
  /^(?:你|您)(?:现在)?(?:在)?哪(?:里|儿)?[？?。！!]*$/i,
  /^(?:where\s+are\s+you|where\s+r\s+u)[?.!]*$/i,
];

const BARE_ARTIFACT_FOLLOW_UP_PATTERNS = [
  /^(?:在)?哪(?:里|儿)[？?。！!]*$/i,
  /^放哪(?:里|儿)?了?[？?。！!]*$/i,
  /^保存在哪(?:里|儿)?[？?。！!]*$/i,
  /^路径(?:是什(?:么|麼)|呢)?[？?。！!]*$/i,
  /^哪(?:个|些)文件[？?。！!]*$/i,
  /^怎么打开[？?。！!]*$/i,
  /^(?:where\s+is\s+it|where|which\s+file|how\s+do\s+i\s+open\s+it)[?.!]*$/i,
];

const EXPLICIT_ARTIFACT_FOLLOW_UP_PATTERNS = [
  /(?:改|修改|生成|创建|新建|保存|写入|写进).*(?:哪(?:个|些)文件|什么文件)/i,
  /(?:刚才|上一轮|上一个).*(?:文件|代码|页面|脚本|实现)(?:呢|呀|啊)?[？?。！!]*$/i,
  /(?:刚才|上一轮|上一个|生成|创建|新建|修改|保存|写入|写进).*(?:文件|代码|页面|脚本|实现)?.*(?:在哪|哪里|哪儿|路径|位置|放哪|怎么打开)/i,
  /(?:文件|代码文件|页面|脚本|实现).*(?:在哪|哪里|哪儿|路径|位置|放哪|怎么打开)/i,
  /(?:where|path|location|open).*(?:file|code|page|script|created|generated|saved)/i,
  /(?:file|code|page|script).*(?:where|path|location|open)/i,
];

export function resolveArtifactFollowUp(
  repoPath: string,
  userGoal: string,
  records: SessionRecord[],
): ArtifactFollowUpResolution | undefined {
  const normalizedGoal = userGoal.trim();
  if (!looksLikeArtifactFollowUp(normalizedGoal)) {
    return undefined;
  }

  const files = findLatestTurnArtifacts(repoPath, records);
  if (files.length === 0) {
    return undefined;
  }

  const intent = classifyArtifactFollowUpIntent(normalizedGoal);
  return {
    intent,
    source: "FILE_CHANGE",
    files,
    answer: renderArtifactFollowUpAnswer(intent, files),
  };
}

export function looksLikeArtifactFollowUp(userGoal: string): boolean {
  const normalized = userGoal.trim();
  if (normalized.length === 0 || normalized.startsWith("/")) {
    return false;
  }
  if (AGENT_LOCATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return BARE_ARTIFACT_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized))
    || EXPLICIT_ARTIFACT_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findLatestTurnArtifacts(repoPath: string, records: SessionRecord[]): ResolvedArtifact[] {
  const previousUserIndex = findLastRecordIndex(records, (record) => record.type === "USER_MESSAGE");
  if (previousUserIndex < 0) {
    return [];
  }

  const repoRoot = path.resolve(repoPath);
  const artifacts = new Map<string, ResolvedArtifact>();
  for (let index = previousUserIndex + 1; index < records.length; index += 1) {
    const record = records[index];
    if (record?.type !== "FILE_CHANGE") {
      continue;
    }
    for (const file of readChangedFiles(record.payload)) {
      const absolutePath = resolveArtifactPath(repoRoot, file.path);
      if (!absolutePath) {
        continue;
      }
      const relativePath = toPosixPath(path.relative(repoRoot, absolutePath));
      artifacts.set(relativePath, {
        relativePath,
        absolutePath,
        changeType: file.changeType,
        exists: existsSync(absolutePath),
      });
    }
  }

  return [...artifacts.values()];
}

function readChangedFiles(payload: JsonObject): Array<{ path: string; changeType: ArtifactChangeType }> {
  if (!Array.isArray(payload.files)) {
    return [];
  }

  return payload.files.flatMap((value) => {
    if (!isJsonObject(value)) {
      return [];
    }
    const filePath = typeof value.path === "string" ? value.path.trim() : "";
    const changeType = normalizeChangeType(value.changeType);
    return filePath && changeType ? [{ path: filePath, changeType }] : [];
  });
}

function resolveArtifactPath(repoRoot: string, filePath: string): string | undefined {
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return absolutePath;
}

function normalizeChangeType(value: unknown): ArtifactChangeType | undefined {
  return value === "ADDED" || value === "MODIFIED" || value === "DELETED" ? value : undefined;
}

function classifyArtifactFollowUpIntent(userGoal: string): ArtifactFollowUpIntent {
  if (/(怎么打开|如何打开|open)/i.test(userGoal)) {
    return "OPEN";
  }
  if (/(哪(?:个|些)文件|什么文件|改了什么|生成了什么|which\s+file)/i.test(userGoal)) {
    return "LIST";
  }
  return "LOCATION";
}

function renderArtifactFollowUpAnswer(intent: ArtifactFollowUpIntent, files: ResolvedArtifact[]): string {
  if (files.length === 1) {
    return renderSingleArtifactAnswer(intent, files[0]!);
  }

  const lines = [
    `上一轮产生了 ${String(files.length)} 个文件变更：`,
    "",
    ...files.map((file) => `- \`${file.absolutePath}\`（${formatChangeType(file.changeType)}）`),
  ];
  if (intent === "OPEN") {
    lines.push("", "可以使用对应的编辑器打开；HTML 文件也可以直接用浏览器打开。");
  }
  return lines.join("\n");
}

function renderSingleArtifactAnswer(intent: ArtifactFollowUpIntent, file: ResolvedArtifact): string {
  if (file.changeType === "DELETED") {
    return `上一轮删除了 \`${file.relativePath}\`；它原来的仓库路径是 \`${file.absolutePath}\`，当前文件已不存在。`;
  }
  if (!file.exists) {
    return `上一轮记录的文件路径是 \`${file.absolutePath}\`，但该文件当前已不存在。`;
  }

  const prefix = file.changeType === "ADDED" ? "上一轮创建的文件在" : "上一轮修改的文件在";
  if (intent !== "OPEN") {
    return `${prefix} \`${file.absolutePath}\`。`;
  }
  const openHint = file.relativePath.toLowerCase().endsWith(".html")
    ? "这是 HTML 文件，可以直接用浏览器打开。"
    : "可以使用你的编辑器打开这个文件。";
  return `${prefix} \`${file.absolutePath}\`。${openHint}`;
}

function formatChangeType(changeType: ArtifactChangeType): string {
  switch (changeType) {
    case "ADDED":
      return "新增";
    case "MODIFIED":
      return "修改";
    case "DELETED":
      return "删除";
  }
}

function findLastRecordIndex(
  records: SessionRecord[],
  predicate: (record: SessionRecord) => boolean,
): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && predicate(record)) {
      return index;
    }
  }
  return -1;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
