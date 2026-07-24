export type DelegationPreference = "AUTO" | "REQUIRED" | "DISABLED";

export interface SubAgentIntent {
  mentioned: boolean;
  capabilityQuestion: boolean;
  preference: DelegationPreference;
  requestedAgents?: number;
  requestsChangeProposal: boolean;
  requestsReview: boolean;
  signals: string[];
}

/**
 * Interprets collaboration intent from composable semantic signals. This is
 * intentionally separate from CLI flags: flags are optional policy overrides,
 * while a user's natural-language request is part of the task itself.
 */
export function classifySubAgentIntent(value: string): SubAgentIntent {
  const text = value.normalize("NFKC").trim().toLowerCase();
  const signals: string[] = [];
  const mentioned = /(?:sub[\s-]*agents?|child[\s-]*agents?|multi[\s-]*agents?|多个\s*(?:agent|代理)|多\s*(?:agent|代理)|子代理|子\s*agent|代理协作|agent\s*协作|委托给.{0,8}agent)/i.test(text);
  const capabilityQuestion = mentioned
    && /(?:有.{0,16}(?:能力)?吗|有吗|有没有|是否有|支持吗|是否支持|具备.{0,6}能力|什么情况|能不能用|can\s+(?:you|we)|do\s+(?:you|we)\s+have|support)/i.test(text)
    && !hasExecutionFrame(text);
  const disabled = mentioned
    && /(?:不要|别|无需|不需要|禁止|关闭|不用).{0,12}(?:sub[\s-]*agent|子代理|多\s*agent|多个\s*agent|代理协作)|(?:without|disable|do not use|don't use|no)\s+(?:sub[\s-]*agents?|multi[\s-]*agents?)/i.test(text);
  const required = mentioned && hasExecutionFrame(text) && !capabilityQuestion && !disabled;
  const requestsChangeProposal = required
    && /(?:写|实现|修改|改造|修复|创建|新增|开发|编码|write|implement|modify|fix|create|build|code)/i.test(text);
  const requestsReview = required
    && /(?:审查|审核|review|检查|复核)/i.test(text);
  const requestedAgents = parseRequestedAgentCount(text);

  if (mentioned) signals.push("subagent-topic");
  if (capabilityQuestion) signals.push("capability-question");
  if (required) signals.push("explicit-delegation");
  if (disabled) signals.push("delegation-disabled");
  if (requestsChangeProposal) signals.push("delegated-change");
  if (requestsReview) signals.push("delegated-review");
  if (requestedAgents !== undefined) signals.push(`requested-agents:${String(requestedAgents)}`);

  return {
    mentioned,
    capabilityQuestion,
    preference: disabled ? "DISABLED" : required ? "REQUIRED" : "AUTO",
    ...(requestedAgents === undefined ? {} : { requestedAgents }),
    requestsChangeProposal,
    requestsReview,
    signals,
  };
}

function hasExecutionFrame(text: string): boolean {
  return /(?:请|帮我|让|使用|用|调用|启动|派|安排|分配|交给|同时|并行).{0,24}(?:sub[\s-]*agent|子代理|多个\s*agent|多\s*agent|代理)|(?:sub[\s-]*agents?|child[\s-]*agents?|multi[\s-]*agents?).{0,24}(?:work|implement|write|review|analy[sz]e|inspect|handle|do|build)|(?:use|spawn|delegate\s+to|assign).{0,12}(?:sub[\s-]*agents?|agents?)/i.test(text);
}

function parseRequestedAgentCount(text: string): number | undefined {
  const numeric = text.match(/(?:用|使用|启动|派|安排|spawn|use)?\s*([1-9])\s*(?:个|名)?\s*(?:sub[\s-]*agents?|agents?|子代理)/i)?.[1];
  if (numeric) return clampAgentCount(Number(numeric));
  if (/(?:两个|2个|two)\s*(?:sub[\s-]*agents?|agents?|子代理)/i.test(text)) return 2;
  if (/(?:三个|3个|three)\s*(?:sub[\s-]*agents?|agents?|子代理)/i.test(text)) return 3;
  return undefined;
}

function clampAgentCount(value: number): number {
  return Math.max(1, Math.min(3, value));
}
