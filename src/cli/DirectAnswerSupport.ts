import { looksLikeFileWriteConfirmation } from "../agent/TaskFollowUp.js";
import { looksLikeWebCapabilityQuestion } from "../agent/TaskRouter.js";
import { classifyErrorText } from "../diagnostics/ErrorClassifier.js";
import type { DiagnosticResult } from "../diagnostics/ErrorClassifier.js";
import type { JsonObject, SessionRecord } from "../session/SessionTypes.js";

export function resolveLocalDirectReply(repoPath: string, userGoal: string): string | undefined {
  const normalized = userGoal
    .trim()
    .replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  if (normalized.length === 0) {
    return undefined;
  }

  const diagnostic = classifyErrorText({ text: userGoal, repoPath });
  if (diagnostic) {
    return renderDiagnosticReply(diagnostic);
  }

  if (looksLikeWebCapabilityQuestion(userGoal.trim().toLowerCase())) {
    return [
      "我有受控联网能力，不是完全离线。",
      "",
      "当前 CLI 可以通过 `web_search` 搜索公开网页结果，也可以通过 `fetch_url` 抓取公网 HTTP(S) 页面文本。它不是浏览器式常驻联网，也没有“联网按钮”；而是当任务被路由到 `WEB_ANSWER` 时，由本地工具按需发起网络请求。",
      "",
      "所以像“今天股市收盘情况”“最新版本”“赛事比分”这类问题，正常应该看到 `[tool] web_search`，必要时还会看到 `[tool] fetch_url`。如果资料源抓不到，我应该说“来源不足以核验”，而不是否认这个项目的联网能力。",
    ].join("\n");
  }

  if (matchesAnyPhrase(normalized, [
    "没事我按错了",
    "没事按错了",
    "按错了",
    "点错了",
    "不小心点错了",
    "误触了",
    "我按错了",
    "我点错了",
  ])) {
    return "好的，没事，你继续说就行。";
  }

  if (matchesAnyPhrase(normalized, [
    "算了",
    "不用了",
    "先这样",
    "先这样吧",
    "当我没说",
    "没事了",
  ])) {
    return "好，先放这儿，需要我时再叫我。";
  }

  return undefined;
}

export function resolveLocalSessionReply(userGoal: string, records: SessionRecord[]): string | undefined {
  return looksLikeFileWriteConfirmation(userGoal)
    ? buildFileWriteConfirmationReply(records)
    : undefined;
}

function renderDiagnosticReply(diagnostic: DiagnosticResult): string {
  const lines = [
    `诊断：${formatDiagnosticCategory(diagnostic.category)}`,
    "",
    diagnostic.explanation,
  ];

  if (diagnostic.evidence.length > 0) {
    lines.push("", "证据：", ...diagnostic.evidence.map((item) => `- ${item}`));
  }

  if (diagnostic.suggestedCommands.length > 0) {
    lines.push("", "建议你这样试：", "", "```bash", ...diagnostic.suggestedCommands, "```");
  }

  return lines.join("\n");
}

function formatDiagnosticCategory(category: DiagnosticResult["category"]): string {
  switch (category) {
    case "WRONG_WORKING_DIRECTORY":
      return "运行目录问题";
    case "COMMAND_NOT_FOUND":
      return "命令不存在";
    case "PORT_IN_USE":
      return "端口占用";
    case "CONNECTION_REFUSED":
      return "连接被拒绝";
    case "PERMISSION_DENIED":
      return "权限不足";
  }
}

function buildFileWriteConfirmationReply(records: SessionRecord[]): string {
  const currentUserIndex = findLastRecordIndex(records, (record) => record.type === "USER_MESSAGE");
  const previousUserIndex = findLastRecordIndex(records, (record) => record.type === "USER_MESSAGE", currentUserIndex - 1);
  const latestChangeAfterPreviousUser = previousUserIndex >= 0
    ? findLastRecordIndex(records, (record) => record.type === "FILE_CHANGE", currentUserIndex - 1, previousUserIndex + 1)
    : -1;

  if (latestChangeAfterPreviousUser >= 0) {
    const files = formatFileChangeFiles(records[latestChangeAfterPreviousUser]?.payload);
    return files.length > 0
      ? `是的，上一轮已经产生文件变更记录：${files.join("、")}。你可以用 /diff 查看具体修改。`
      : "是的，上一轮已经产生文件变更记录。你可以用 /diff 查看具体修改。";
  }

  const latestAnyChange = findLastRecordIndex(records, (record) => record.type === "FILE_CHANGE", currentUserIndex - 1);
  if (latestAnyChange >= 0) {
    const files = formatFileChangeFiles(records[latestAnyChange]?.payload);
    const suffix = files.length > 0 ? `最近一次文件变更是：${files.join("、")}。` : "之前有过文件变更记录。";
    return `没有查到上一轮请求对应的新文件写入记录，刚才那次可能只是回答了内容，没有真正落盘。${suffix}`;
  }

  return "没有查到文件写入记录。刚才可能只是回答了代码或说明，没有真正写入仓库文件。";
}

function findLastRecordIndex(
  records: SessionRecord[],
  predicate: (record: SessionRecord) => boolean,
  startIndex = records.length - 1,
  stopIndex = 0,
): number {
  for (let index = Math.min(startIndex, records.length - 1); index >= stopIndex; index -= 1) {
    const record = records[index];
    if (record && predicate(record)) {
      return index;
    }
  }

  return -1;
}

function formatFileChangeFiles(payload: JsonObject | undefined): string[] {
  const files = payload?.files;
  if (!Array.isArray(files)) {
    return [];
  }

  return files
    .map((file) => {
      if (!isRecord(file) || typeof file.path !== "string") {
        return undefined;
      }

      const changeType = typeof file.changeType === "string" ? file.changeType : "MODIFIED";
      return `${file.path} (${changeType})`;
    })
    .filter((file): file is string => file !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesAnyPhrase(value: string, phrases: string[]): boolean {
  return phrases.includes(value);
}
