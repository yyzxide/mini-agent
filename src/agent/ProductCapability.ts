import {
  getProductCapability,
  listProductCapabilities,
  type ProductCapabilityDefinition,
  type ProductCapabilityId,
} from "./CapabilityRegistry.js";
import { classifySubAgentIntent } from "./SubAgentIntent.js";

export type ProductMetaTopic = "ALL" | "WEB_RESEARCH" | "REPOSITORY_WRITE" | "MULTI_AGENT_COLLABORATION";
export type ProductMetaAct = "INVENTORY" | "AVAILABILITY" | "EXPLAIN_LIMITATION";

export interface ProductMetaIntent {
  kind: "PRODUCT_META";
  topic: ProductMetaTopic;
  act: ProductMetaAct;
  confidence: number;
  signals: string[];
}

/**
 * Classifies product-meta semantics compositionally. It deliberately combines
 * subject, capability topic, modality, question, and historical-reference
 * signals instead of enumerating complete user sentences.
 */
export function classifyProductMetaIntent(value: string): ProductMetaIntent | undefined {
  const normalized = normalize(value);
  if (!normalized.compact) return undefined;

  const signals: string[] = [];
  const subject = hasSubjectSignal(normalized.text);
  const web = hasWebTopic(normalized.text);
  const repositoryWrite = hasRepositoryWriteTopic(normalized.text);
  const subAgent = classifySubAgentIntent(value);
  const generalScope = hasGeneralCapabilityScope(normalized.text);
  const modality = hasCapabilityModality(normalized.text);
  const explanation = hasExplanationFrame(normalized.text);
  const question = hasQuestionFrame(value, normalized.text);
  const explicitAction = looksLikeExplicitWebAction(value);

  if (subject) signals.push("product-subject");
  if (web) signals.push("web-topic");
  if (repositoryWrite) signals.push("repository-write-topic");
  if (subAgent.mentioned) signals.push("multi-agent-topic");
  if (generalScope) signals.push("general-capability-scope");
  if (modality) signals.push("capability-modality");
  if (explanation) signals.push("historical-explanation");
  if (question) signals.push("question-frame");

  // “请联网查一下” is an action request even though it mentions networking.
  if (explicitAction && !explanation && !question) return undefined;

  const topic: ProductMetaTopic = [web, repositoryWrite, subAgent.mentioned].filter(Boolean).length > 1
    ? "ALL"
    : web
      ? "WEB_RESEARCH"
      : repositoryWrite
        ? "REPOSITORY_WRITE"
        : subAgent.mentioned
          ? "MULTI_AGENT_COLLABORATION"
          : "ALL";
  const act: ProductMetaAct = explanation
    ? "EXPLAIN_LIMITATION"
    : generalScope || (!web && !repositoryWrite && !subAgent.mentioned) ? "INVENTORY" : "AVAILABILITY";

  const isCapabilityQuestion = generalScope
    || explanation
    || subAgent.capabilityQuestion
    || ((web || repositoryWrite || subAgent.mentioned) && modality && (subject || question));
  if (!isCapabilityQuestion) return undefined;

  let confidence = 0.45;
  if (subject) confidence += 0.12;
  if (web || repositoryWrite || subAgent.mentioned) confidence += 0.16;
  if (generalScope) confidence += 0.22;
  if (modality) confidence += 0.12;
  if (explanation) confidence += 0.18;
  if (question) confidence += 0.08;
  if (explicitAction) confidence -= 0.2;

  return {
    kind: "PRODUCT_META",
    topic,
    act,
    confidence: Math.max(0, Math.min(1, confidence)),
    signals,
  };
}

export function renderProductCapabilityAnswer(
  intent: ProductMetaIntent,
  options: { priorDenialFound?: boolean; locale?: "zh" | "en" } = {},
): string {
  const locale = options.locale ?? "zh";
  if (intent.act === "EXPLAIN_LIMITATION") {
    return renderLimitationExplanation(intent.topic, options.priorDenialFound === true, locale);
  }
  if (intent.topic === "WEB_RESEARCH") {
    return renderFocusedCapability(getProductCapability("WEB_RESEARCH"), locale);
  }
  if (intent.topic === "REPOSITORY_WRITE") {
    return renderFocusedCapability(getProductCapability("REPOSITORY_WRITE"), locale);
  }
  if (intent.topic === "MULTI_AGENT_COLLABORATION") {
    return renderFocusedCapability(getProductCapability("MULTI_AGENT_COLLABORATION"), locale);
  }
  return renderInventory(locale);
}

export function detectResponseCapabilityDenials(text: string): ProductCapabilityId[] {
  const conflicts: ProductCapabilityId[] = [];
  if (containsGlobalDenial(text, "WEB_RESEARCH") && !containsAffirmation(text, "WEB_RESEARCH")) {
    conflicts.push("WEB_RESEARCH");
  }
  if (containsGlobalDenial(text, "REPOSITORY_WRITE") && !containsAffirmation(text, "REPOSITORY_WRITE")) {
    conflicts.push("REPOSITORY_WRITE");
  }
  if (containsGlobalDenial(text, "MULTI_AGENT_COLLABORATION") && !containsAffirmation(text, "MULTI_AGENT_COLLABORATION")) {
    conflicts.push("MULTI_AGENT_COLLABORATION");
  }
  return conflicts;
}

export function looksLikeExplicitWebAction(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /(?:请|帮我|麻烦|直接|现在)?(?:联网|上网|网上|用网页|web)?(?:查|查询|查找|搜|搜索|检索|浏览)(?:一下|一查|看看|找找)?/i.test(text)
    || /(?:联网|上网|网上|用网页|\bweb\b).{0,10}(?:核实|核验|查证|验证|事实核查)/i.test(text)
    || /(?:search|browse|look\s*up|find).{0,12}(?:web|online|internet)/i.test(text)
    || /(?:search|browse)(?:\s+the)?\s+web/i.test(text);
}

export function inferLocale(value: string): "zh" | "en" {
  return /[\u3400-\u9fff]/u.test(value) ? "zh" : "en";
}

function renderInventory(locale: "zh" | "en"): string {
  const entries = listProductCapabilities();
  if (locale === "en") {
    return [
      "Mini Coding Agent uses one runtime and selects a least-privilege task contract automatically for each request.",
      "",
      ...entries.map((entry) => `- ${entry.en.name}: ${entry.en.description}${entry.tools.length > 0 ? ` Tools: ${entry.tools.map((tool) => `\`${tool}\``).join(", ")}.` : ""}`),
      "",
      "A capability disabled in one direct-response request is only unavailable to that request; it is not missing from the overall product.",
    ].join("\n");
  }
  return [
    "Mini Coding Agent 使用一个统一运行时，并会为每条请求自动选择最小权限的任务契约，不需要手动切换模式。",
    "",
    ...entries.map((entry) => `- ${entry.zh.name}：${entry.zh.description}${entry.tools.length > 0 ? ` 工具：${entry.tools.map((tool) => `\`${tool}\``).join("、")}。` : ""}`),
    "",
    "某条直接回答没有开放某项工具，只表示该请求不需要这项能力，不代表整个产品缺少它。",
  ].join("\n");
}

function renderFocusedCapability(entry: ProductCapabilityDefinition, locale: "zh" | "en"): string {
  if (locale === "en") {
    return [
      `Yes. ${entry.en.name} is supported. ${entry.en.description}`,
      entry.tools.length > 0 ? `It is provided through ${entry.tools.map((tool) => `\`${tool}\``).join(" and ")} under the ${entry.contracts.map((contract) => `\`${contract}\``).join(" / ")} task contract.` : "",
      entry.en.limitation ?? "",
      "Task contracts are selected automatically from the user's goal; a direct-answer request does not define the product's global capabilities.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    `支持${entry.zh.name}。${entry.zh.description}`,
    entry.tools.length > 0 ? `该能力通过 ${entry.tools.map((tool) => `\`${tool}\``).join("、")} 提供，对应 ${entry.contracts.map((contract) => `\`${contract}\``).join(" / ")} 任务契约。` : "",
    entry.zh.limitation ?? "",
    "任务契约会根据用户目标自动选择；某条直接回答没有开放工具，并不代表产品没有该能力。",
  ].filter(Boolean).join("\n\n");
}

function renderLimitationExplanation(
  topic: ProductMetaTopic,
  priorDenialFound: boolean,
  locale: "zh" | "en",
): string {
  const entries = topic === "ALL"
    ? [
      getProductCapability("WEB_RESEARCH"),
      getProductCapability("REPOSITORY_WRITE"),
      getProductCapability("MULTI_AGENT_COLLABORATION"),
    ]
    : [getProductCapability(topic)];
  if (locale === "en") {
    return [
      priorDenialFound ? "The previous answer was wrong; the session contains a false capability denial." : "A previous capability denial would be an answer error, not an actual product limitation.",
      "The model confused the current request's least-privilege TaskContract with the overall product capability registry.",
      `The registry is authoritative: ${entries.map((entry) => `${entry.en.name} is supported through ${entry.tools.join(" / ")}`).join("; ")}.`,
      "Explaining this contradiction uses local product and session facts. It must not trigger unrelated web searches merely to prove that networking works.",
    ].join("\n\n");
  }
  return [
    priorDenialFound ? "上一轮回答错了；会话记录中确实存在与产品事实冲突的能力否认。" : "如果之前否认了这项能力，那是回答错误，不是产品真的缺少能力。",
    "根因是模型把当前请求的最小权限 TaskContract 错误泛化成了整个产品的能力清单。",
    `Capability Registry 才是权威事实源：${entries.map((entry) => `${entry.zh.name}由 ${entry.tools.map((tool) => `\`${tool}\``).join("、")} 提供`).join("；")}。`,
    "解释这类矛盾只需要本地产品事实和 Session 记录，不应该为了证明联网能力而搜索天气或外部 AI 资料。",
  ].join("\n\n");
}

function containsGlobalDenial(text: string, capability: "WEB_RESEARCH" | "REPOSITORY_WRITE" | "MULTI_AGENT_COLLABORATION"): boolean {
  const normalized = text.toLowerCase();
  if (capability === "MULTI_AGENT_COLLABORATION") {
    return /(?:我|mini\s*coding\s*agent|这个(?:cli|助手|agent))?.{0,12}(?:不能|无法|不支持|没有(?:办法|能力)?).{0,12}(?:sub[\s-]*agent|子代理|多\s*agent|多个\s*agent|代理协作)/i.test(normalized);
  }
  return capability === "WEB_RESEARCH"
    ? /(?:我|mini\s*coding\s*agent|这个(?:cli|助手|agent))?.{0,8}(?:不能|无法|不支持|没有(?:办法|能力)?).{0,12}(?:联网|上网|互联网|外网|访问网页|web\s*搜索|browse|internet)/i.test(normalized)
    : /(?:我|mini\s*coding\s*agent|这个(?:cli|助手|agent))?.{0,8}(?:不能|无法|不支持|没有(?:办法|能力)?).{0,12}(?:写入|修改|编辑|创建|保存|落盘).{0,8}(?:文件|代码|仓库)/i.test(normalized);
}

function containsAffirmation(text: string, capability: "WEB_RESEARCH" | "REPOSITORY_WRITE" | "MULTI_AGENT_COLLABORATION"): boolean {
  if (capability === "MULTI_AGENT_COLLABORATION") {
    return /(?:可以|能够|支持|具备).{0,12}(?:sub[\s-]*agent|子代理|多\s*agent|多个\s*agent|代理协作)|(?:delegate|apply_delegated_patch)/i.test(text);
  }
  return capability === "WEB_RESEARCH"
    ? /(?:可以|能够|支持|具备|有).{0,10}(?:联网|上网|访问网页|web_search|fetch_url)|(?:联网|web).{0,10}(?:能力|支持)/i.test(text)
    : /(?:可以|能够|支持|具备|有).{0,10}(?:写入|修改|编辑|创建|保存).{0,8}(?:文件|代码|仓库)|(?:apply_patch|repository_task)/i.test(text);
}

function hasSubjectSignal(text: string): boolean {
  return /(?:你|你的|这个(?:cli|助手|agent|程序|项目)|mini[\s-]*(?:agent|coding agent)|本(?:系统|项目|助手)|your|you|this\s+(?:cli|agent|assistant|product))/i.test(text);
}

function hasWebTopic(text: string): boolean {
  return /(?:联网|互联网|上网|外网|网页|网络搜索|web[\s_-]*search|fetch[\s_-]*url|browse|browsing|internet|online)/i.test(text);
}

function hasRepositoryWriteTopic(text: string): boolean {
  return /(?:(?:写|写入|改|修改|编辑|创建|保存|落盘|动).{0,8}(?:文件|代码|仓库|项目)|(?:文件|代码|仓库).{0,8}(?:写入|修改|编辑|创建|保存|落盘)|apply[\s_-]*patch|repository[\s_-]*write|(?:write|edit|modify|change|create)\s+(?:repository\s+)?files?)/i.test(text);
}

function hasGeneralCapabilityScope(text: string): boolean {
  return /(?:干啥|做啥|做什么|能做哪些|可以做哪些|会些什么|有什么能力|哪些能力|能力(?:清单|范围|边界|是什么)|哪些功能|功能清单|哪些类型的任务|处理哪些任务|能帮.{0,4}什么|what\s+can\s+you\s+do|what\s+can\s+you\s+help|capabilit(?:y|ies)|feature\s+list)/i.test(text);
}

function hasCapabilityModality(text: string): boolean {
  return /(?:能不能|能否|是否能|可以吗|是否可以|会不会|支持吗|是否支持|具备|能力|权限|只能|只会|不能|无法|没法|办不到|碰不到|永久限制|can\s+you|could\s+you|do\s+you\s+(?:have|support)|are\s+you\s+able|cannot|can't|unable|capabilit|permission)/i.test(text);
}

function hasExplanationFrame(text: string): boolean {
  return /(?:(?:为什么|为何|怎么会).{0,18}(?:说|声称|表示|认为|不能|无法|限制)|(?:之前|刚才|上一轮|前面).{0,18}(?:说|不能|无法|限制|权限)|(?:限制|权限).{0,8}(?:永久|一直|以后)|why\s+(?:did|do)\s+you\s+(?:say|claim)|previous(?:ly)?.{0,20}(?:said|claimed|limit)|permanent\s+(?:limit|restriction))/i.test(text);
}

function hasQuestionFrame(raw: string, text: string): boolean {
  return /[?？]/.test(raw)
    || /(?:吗|么|呢|到底|是不是|是否|为什么|为何|怎么会)/.test(text)
    || /^(?:can|could|do|does|are|why|what)\b/i.test(text.trim());
}

function normalize(value: string): { text: string; compact: string } {
  const text = value.trim().toLowerCase();
  return {
    text,
    compact: text.replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】`]/g, ""),
  };
}
