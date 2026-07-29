import {
  getProductCapability,
  listProductCapabilities,
  type ProductCapabilityDefinition,
  type ProductCapabilityId,
} from "./CapabilityRegistry.js";

export type ProductMetaTopic = "ALL" | "WEB_RESEARCH" | "REPOSITORY_WRITE" | "MULTI_AGENT_COLLABORATION";
export type ProductMetaAct = "INVENTORY" | "AVAILABILITY" | "EXPLAIN_LIMITATION";

export interface ProductCapabilityView {
  topic: ProductMetaTopic;
  act: ProductMetaAct;
}

export function renderProductCapabilityAnswer(
  intent: ProductCapabilityView,
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

export function inferLocale(value: string): "zh" | "en" {
  return /[\u3400-\u9fff]/u.test(value) ? "zh" : "en";
}

function renderInventory(locale: "zh" | "en"): string {
  const entries = listProductCapabilities();
  if (locale === "en") {
    return [
      "Mini Coding Agent uses one AgentLoop and compiles each request into a least-privilege TaskFrame.",
      "",
      ...entries.map((entry) => `- ${entry.en.name}: ${entry.en.description}${entry.tools.length > 0 ? ` Tools: ${entry.tools.map((tool) => `\`${tool}\``).join(", ")}.` : ""}`),
      "",
      "A capability disabled for one request is only unavailable to that request; it is not missing from the overall product.",
    ].join("\n");
  }
  return [
    "Mini Coding Agent 使用一个 AgentLoop，并把每条请求编译为最小权限 TaskFrame，不需要手动切换模式。",
    "",
    ...entries.map((entry) => `- ${entry.zh.name}：${entry.zh.description}${entry.tools.length > 0 ? ` 工具：${entry.tools.map((tool) => `\`${tool}\``).join("、")}。` : ""}`),
    "",
    "某条请求没有开放某项工具，只表示该请求不需要这项能力，不代表整个产品缺少它。",
  ].join("\n");
}

function renderFocusedCapability(entry: ProductCapabilityDefinition, locale: "zh" | "en"): string {
  if (locale === "en") {
    return [
      `Yes. ${entry.en.name} is supported. ${entry.en.description}`,
      entry.tools.length > 0 ? `It is provided through ${entry.tools.map((tool) => `\`${tool}\``).join(" and ")} when TaskFrame enables ${entry.effects.map((effect) => `\`${effect}\``).join(" / ")}.` : "",
      entry.en.limitation ?? "",
      "TaskFrame effects are selected from the user's goal; one request's grants do not define the product's global capabilities.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    `支持${entry.zh.name}。${entry.zh.description}`,
    entry.tools.length > 0 ? `该能力通过 ${entry.tools.map((tool) => `\`${tool}\``).join("、")} 提供，由 TaskFrame 的 ${entry.effects.map((effect) => `\`${effect}\``).join(" / ")} 效果授权。` : "",
    entry.zh.limitation ?? "",
    "TaskFrame 会根据用户目标生成；某条请求没有开放工具，并不代表产品没有该能力。",
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
