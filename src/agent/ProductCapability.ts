import {
  getProductCapability,
  listProductCapabilities,
  type ProductCapabilityDefinition,
  type ProductCapabilityId,
} from "./CapabilityRegistry.js";

export type ProductMetaAct = "NONE" | "INVENTORY" | "AVAILABILITY" | "EXPLAIN_LIMITATION";

export interface ProductCapabilityView {
  capabilityIds: ProductCapabilityId[];
  act: ProductMetaAct;
}

export function renderProductCapabilityAnswer(
  intent: ProductCapabilityView,
  options: { priorDenialFound?: boolean; locale?: "zh" | "en" } = {},
): string {
  const locale = options.locale ?? "zh";
  const entries = selectCapabilities(intent.capabilityIds);
  if (intent.act === "EXPLAIN_LIMITATION") {
    return renderLimitationExplanation(entries, options.priorDenialFound === true, locale);
  }
  if (intent.act === "AVAILABILITY" && intent.capabilityIds.length > 0) {
    return renderFocusedCapabilities(entries, locale);
  }
  return renderInventory(locale);
}

export function inferLocale(value: string): "zh" | "en" {
  return /[\u3400-\u9fff]/u.test(value) ? "zh" : "en";
}

function selectCapabilities(ids: ProductCapabilityId[]): ProductCapabilityDefinition[] {
  if (ids.length === 0) return listProductCapabilities();
  return [...new Set(ids)].map((id) => getProductCapability(id));
}

function renderInventory(locale: "zh" | "en"): string {
  const entries = listProductCapabilities();
  if (locale === "en") {
    return [
      "Mini Coding Agent uses one AgentLoop and compiles each request into a least-privilege TaskFrame.",
      "",
      ...entries.map((entry) => `- ${entry.en.name}: ${entry.en.description}${renderMechanisms(entry, "en")}`),
      "",
      "A capability disabled for one request is only unavailable to that request; it is not missing from the overall product.",
    ].join("\n");
  }
  return [
    "Mini Coding Agent 使用一个 AgentLoop，并把每条请求编译为最小权限 TaskFrame，不需要手动切换模式。",
    "",
    ...entries.map((entry) => `- ${entry.zh.name}：${entry.zh.description}${renderMechanisms(entry, "zh")}`),
    "",
    "某条请求没有开放某项工具，只表示该请求不需要这项能力，不代表整个产品缺少它。",
  ].join("\n");
}

function renderFocusedCapabilities(
  entries: ProductCapabilityDefinition[],
  locale: "zh" | "en",
): string {
  if (entries.length === 1) return renderFocusedCapability(entries[0]!, locale);
  if (locale === "en") {
    return [
      "Yes. Mini Coding Agent supports the following capabilities:",
      "",
      ...entries.map((entry) => `- ${entry.en.name}: ${entry.en.description}${renderMechanisms(entry, "en")}${entry.en.limitation ? ` Limitation: ${entry.en.limitation}` : ""}`),
      "",
      "TaskFrame effects are selected from the user's goal; one request's grants do not define the product's global capabilities.",
    ].join("\n");
  }
  return [
    "Mini Coding Agent 支持以下能力：",
    "",
    ...entries.map((entry) => `- ${entry.zh.name}：${entry.zh.description}${renderMechanisms(entry, "zh")}${entry.zh.limitation ? ` 边界：${entry.zh.limitation}` : ""}`),
    "",
    "TaskFrame 会根据用户目标生成；某条请求没有开放工具，并不代表产品没有该能力。",
  ].join("\n");
}

function renderFocusedCapability(entry: ProductCapabilityDefinition, locale: "zh" | "en"): string {
  if (locale === "en") {
    return [
      `Yes. ${entry.en.name} is supported. ${entry.en.description}`,
      renderCapabilityMechanismParagraph(entry, "en"),
      entry.en.limitation ?? "",
      "TaskFrame effects are selected from the user's goal; one request's grants do not define the product's global capabilities.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    `支持${entry.zh.name}。${entry.zh.description}`,
    renderCapabilityMechanismParagraph(entry, "zh"),
    entry.zh.limitation ?? "",
    "TaskFrame 会根据用户目标生成；某条请求没有开放工具，并不代表产品没有该能力。",
  ].filter(Boolean).join("\n\n");
}

function renderLimitationExplanation(
  entries: ProductCapabilityDefinition[],
  priorDenialFound: boolean,
  locale: "zh" | "en",
): string {
  if (locale === "en") {
    return [
      priorDenialFound
        ? "The previous answer was inconsistent with the local product registry."
        : "The local Capability Registry is the authoritative source for product availability and boundaries.",
      "The per-request TaskContract is a least-privilege grant, so a disabled effect in one task must not be generalized into a missing product capability.",
      ...entries.map((entry) => `- ${entry.en.name}: supported. ${entry.en.description}${renderMechanisms(entry, "en")}${entry.en.limitation ? ` Limitation: ${entry.en.limitation}` : ""}`),
    ].join("\n\n");
  }
  return [
    priorDenialFound
      ? "上一轮回答与本地产品能力注册表不一致。"
      : "本地 Capability Registry 是产品能力及其边界的权威事实源。",
    "当轮 TaskContract 只是最小权限授权，不能把某次任务没有开放的效果泛化成产品缺少该能力。",
    ...entries.map((entry) => `- ${entry.zh.name}：已支持。${entry.zh.description}${renderMechanisms(entry, "zh")}${entry.zh.limitation ? ` 边界：${entry.zh.limitation}` : ""}`),
  ].join("\n\n");
}

function renderCapabilityMechanismParagraph(
  entry: ProductCapabilityDefinition,
  locale: "zh" | "en",
): string {
  const mechanisms = formatMechanismNames(entry);
  if (mechanisms.length === 0) return "";
  const effects = entry.effects.map((effect) => `\`${effect}\``).join(" / ");
  return locale === "en"
    ? `It is exposed through ${mechanisms} and represented by ${effects} in the product capability model.`
    : `该能力通过 ${mechanisms} 提供，并在产品能力模型中登记为 ${effects}。`;
}

function formatMechanismNames(entry: ProductCapabilityDefinition): string {
  return [...entry.tools, ...entry.actions, ...entry.surfaces]
    .map((name) => `\`${name}\``)
    .join("、");
}

function renderMechanisms(entry: ProductCapabilityDefinition, locale: "zh" | "en"): string {
  const parts = [
    entry.tools.length > 0 ? `${locale === "zh" ? "工具" : "Tools"}: ${entry.tools.map((name) => `\`${name}\``).join(locale === "zh" ? "、" : ", ")}` : undefined,
    entry.actions.length > 0 ? `${locale === "zh" ? "动作" : "Actions"}: ${entry.actions.map((name) => `\`${name}\``).join(locale === "zh" ? "、" : ", ")}` : undefined,
    entry.surfaces.length > 0 ? `${locale === "zh" ? "入口" : "Entry points"}: ${entry.surfaces.map((name) => `\`${name}\``).join(locale === "zh" ? "、" : ", ")}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return parts.length > 0 ? ` ${parts.join(locale === "zh" ? "；" : "; ")}。` : "";
}
