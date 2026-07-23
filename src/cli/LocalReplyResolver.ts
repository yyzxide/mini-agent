import { looksLikeFileWriteConfirmation } from "../agent/TaskFollowUp.js";
import {
  looksLikeCacheResponsibilityQuestion,
  looksLikeRagCapabilityQuestion,
} from "../agent/TaskRouter.js";
import {
  classifyProductMetaIntent,
  detectResponseCapabilityDenials,
  inferLocale,
  renderProductCapabilityAnswer,
  type ProductMetaTopic,
} from "../agent/ProductCapability.js";
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

  const productMeta = classifyProductMetaIntent(userGoal);
  if (productMeta && productMeta.confidence >= 0.65 && productMeta.act !== "EXPLAIN_LIMITATION") {
    return renderProductCapabilityAnswer(productMeta, { locale: inferLocale(userGoal) });
  }

  if (looksLikeModeInventoryQuestion(lower, normalized)) {
    return [
      "Mini Coding Agent 现在只有一个统一的 `AgentLoop` 运行时，不再为普通问答、联网检索、代码审查和仓库分析维护四套执行链。",
      "",
      "每条请求会生成不同的任务契约，用来限定可用能力、证据门槛、输出格式和执行预算。`PLAN` 是只读运行模式；直接回答、Web 研究、代码审查和仓库分析只是契约配置，不是独立 Agent。",
    ].join("\n");
  }

  if (looksLikeWebAnswerModeQuestion(lower, normalized)) {
    return "联网回答由统一 `AgentLoop` 的 `WEB_RESEARCH` 任务契约处理，不是独立执行器。契约只开放 `web_search` 和 `fetch_url`，并要求达到来源和引用门槛后才能完成。";
  }

  if (matchesAnyPhrase(normalized, ["你可以切换吗", "可以切换吗", "你能切换吗", "能切换吗"])) {
    return "通常不用手动切换。CLI 会为每条输入建立相应任务契约，再交给同一个 AgentLoop；你直接说“联网搜一下上一问”或“审查这个文件”即可。";
  }

  if (looksLikeRagCapabilityQuestion(userGoal)) {
    return [
      "有。Mini Coding Agent 实现的是仓库本地的文档知识库 RAG，不是把历史聊天记录换个名字叫 RAG。",
      "",
      "它先通过 `mini-agent rag ingest` 把仓库内的 Markdown/TXT 文档分块并索引到 `.mini-agent/rag/index.jsonl`，Agent 再用只读的 `knowledge_search` 做关键词与向量混合检索，返回文件行号引用；证据不足时会明确拒答。",
      "",
      "这与 `.mini-agent/memory/index.jsonl` 完全分开：后者保存任务摘要、会话压缩和显式记忆，用于历史上下文召回，不是文档知识库 RAG。当前 RAG 是单仓库、本地 JSONL 的轻量实现，不是大规模生产向量平台。",
    ].join("\n");
  }

  if (looksLikeCacheResponsibilityQuestion(userGoal)) {
    return [
      "要分层看：缓存命中不是模型在对话里自行决定的工具动作。",
      "",
      "- LLM 的 KV/Prompt Cache 由模型服务端维护；Agent 保持可复用的提示前缀，并记录服务端返回的 `cached_tokens`。",
      "- RAG/Memory 使用的远端 embedding 缓存由 Agent 基础设施维护，按 provider/vector-space 和文本哈希自动读写 `.mini-agent/cache/embeddings/v1/`。",
      "- 文档 RAG 索引和长期记忆是索引或业务数据，不应混称为缓存；完整回答和 `AgentDecision` 也不会直接缓存重放，以免使用过期上下文或重复副作用。",
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
  if (looksLikeFileWriteConfirmation(userGoal)) {
    return buildFileWriteConfirmationReply(records, userGoal);
  }

  const productMeta = classifyProductMetaIntent(userGoal);
  if (productMeta && productMeta.confidence >= 0.65 && productMeta.act === "EXPLAIN_LIMITATION") {
    const priorDenialFound = records.some((record) => recordContainsCapabilityDenial(record, productMeta.topic));
    return renderProductCapabilityAnswer(productMeta, {
      priorDenialFound,
      locale: inferLocale(userGoal),
    });
  }
  return undefined;
}

function recordContainsCapabilityDenial(
  record: SessionRecord,
  topic: ProductMetaTopic,
): boolean {
  const value = record.type === "ASSISTANT_MESSAGE"
    ? record.payload.content
    : record.type === "TASK_SUMMARY" ? record.payload.summary : undefined;
  if (typeof value !== "string") return false;
  const denials = detectResponseCapabilityDenials(value);
  return topic === "ALL"
    ? denials.length > 0
    : denials.includes(topic);
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

function buildFileWriteConfirmationReply(records: SessionRecord[], currentUserGoal: string): string {
  const latestUserIndex = findLastRecordIndex(records, (record) => record.type === "USER_MESSAGE");
  const currentAlreadyRecorded = latestUserIndex >= 0
    && records[latestUserIndex]?.payload.content === currentUserGoal;
  const currentUserIndex = currentAlreadyRecorded ? latestUserIndex : records.length;
  const previousUserIndex = currentAlreadyRecorded
    ? findLastRecordIndex(records, (record) => record.type === "USER_MESSAGE", currentUserIndex - 1)
    : latestUserIndex;
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
