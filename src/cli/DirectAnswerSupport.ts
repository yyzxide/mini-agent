import { looksLikeFileWriteConfirmation } from "../agent/TaskFollowUp.js";
import { looksLikeWebCapabilityQuestion } from "../agent/TaskRouter.js";
import { classifyErrorText } from "../diagnostics/ErrorClassifier.js";
import type { DiagnosticResult } from "../diagnostics/ErrorClassifier.js";
import type { JsonObject, SessionRecord } from "../session/SessionTypes.js";

export interface LocalProductContext {
  configuredModel?: string;
}

export function resolveLocalDirectReply(
  repoPath: string,
  userGoal: string,
  productContext: LocalProductContext = {},
): string | undefined {
  const lower = userGoal.trim().toLowerCase();
  const normalized = userGoal
    .trim()
    .toLowerCase()
    .replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  if (normalized.length === 0) {
    return undefined;
  }

  const diagnostic = classifyErrorText({ text: userGoal, repoPath });
  if (diagnostic) {
    return renderDiagnosticReply(diagnostic);
  }

  if (looksLikeModelIdentityQuestion(lower, normalized)) {
    const configuredModel = productContext.configuredModel?.trim();
    return configuredModel
      ? `我是 Mini Coding Agent。这个 CLI 当前配置的模型标识是 \`${configuredModel}\`；实际由哪个服务提供，以你的 base URL 和服务端配置为准。`
      : "我是 Mini Coding Agent。当前没有读取到明确的模型标识，请检查 `mini-agent.config.json`、`.mini-agent/config.json` 或 `MINI_AGENT_MODEL`。";
  }

  if (matchesAnyPhrase(normalized, ["你没有名字吗", "你叫什么名字", "你的名字是什么", "你叫啥"])) {
    return "我叫 Mini Coding Agent，是运行在这个仓库里的本地代码助手。";
  }

  if (looksLikeModeInventoryQuestion(lower, normalized)) {
    return [
      "Mini Coding Agent 有 5 条主要处理路径：`DIRECT_ANSWER`（普通问答）、`WEB_ANSWER`（联网检索）、`CODE_REVIEW`（代码审查）、`AGENT_LOOP`（仓库任务）和只读的 `PLAN`。",
      "",
      "它们不是需要退出会话后手动重开的聊天模式。CLI 会根据每一条输入自动路由；你也可以直接说“联网搜一下……”或使用相应命令明确意图。",
    ].join("\n");
  }

  if (looksLikeWebAnswerModeQuestion(lower, normalized)) {
    return "有 `WEB_ANSWER` 联网处理路径。它不是一个需要手动进入的独立聊天室；每条输入都会重新路由，实时信息或明确要求联网时会自动调用 `web_search`，必要时再调用 `fetch_url`。";
  }

  if (matchesAnyPhrase(normalized, ["你可以切换吗", "可以切换吗", "你能切换吗", "能切换吗"])) {
    return "可以，但通常不用手动切换。CLI 会按每条输入自动选择普通问答、联网检索、代码审查或仓库任务路径；你直接说“联网搜一下上一问”即可。";
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

function looksLikeModelIdentityQuestion(lower: string, normalized: string): boolean {
  return matchesAnyPhrase(normalized, [
    "你是什么模型",
    "你的模型是什么",
    "你用的什么模型",
    "你用什么模型",
    "模型版本是什么",
  ]) || /\b(?:what(?:'s|\s+is)|whats)\s+(?:your|ur)\s+model\b/i.test(lower);
}

function looksLikeModeInventoryQuestion(lower: string, normalized: string): boolean {
  return matchesAnyPhrase(normalized, [
    "你总共有几种对话模式",
    "你有几种对话模式",
    "总共有几种模式",
    "有哪些对话模式",
    "有哪些模式",
  ]) || /\b(?:what|which|how\s+many)\s+(?:chat\s+)?modes?\b/i.test(lower);
}

function looksLikeWebAnswerModeQuestion(lower: string, normalized: string): boolean {
  return normalized.includes("webanswer模式")
    || normalized.includes("联网模式")
    || /\bweb[-\s]?answer\s+mode\b/i.test(lower);
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
