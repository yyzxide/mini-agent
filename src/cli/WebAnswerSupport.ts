import { formatRuntimeContext } from "../context/RuntimeContext.js";
import type { ToolResult } from "../tools/Tool.js";
import type { WebQuestionPlan } from "../web/WebQuestionPlanner.js";

export interface WebAnswerSource {
  title: string;
  url: string;
  snippet: string;
  query?: string;
  fetch?: FetchedWebSource;
  fetchError?: string;
}

export interface FetchedWebSource {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  outputTruncated: boolean;
}

export function buildWebAnswerContext(input: {
  userGoal: string;
  webPlan: WebQuestionPlan;
  sessionMemory: string;
  searchQueries: string[];
  searchResults: Array<{ query: string; result: ToolResult<unknown> }>;
  sources: WebAnswerSource[];
}): string {
  const fetchedSourceCount = input.sources.filter((source) => source.fetch).length;
  const failedFetchCount = input.sources.filter((source) => source.fetchError).length;
  const lines = [
    "Runtime context:",
    formatRuntimeContext(),
    "",
    "Conversation context:",
    input.sessionMemory,
    "",
    `Original web question: ${input.userGoal}`,
    `Standalone web question: ${input.webPlan.standaloneQuestion}`,
    `Answer scope: ${input.webPlan.answerScope}`,
    `Needs live/current data: ${input.webPlan.needsLiveData}`,
    input.webPlan.plannerError ? `Planner fallback reason: ${input.webPlan.plannerError}` : undefined,
    "",
    "Source hints:",
    ...(input.webPlan.sourceHints.length > 0 ? input.webPlan.sourceHints.map((hint) => `- ${hint}`) : ["- (none)"]),
    "",
    "Resolved search queries:",
    ...input.searchQueries.map((query, index) => `${index + 1}. ${query}`),
    "",
    "Answering rules:",
    ...(input.webPlan.answerInstructions.length > 0
      ? input.webPlan.answerInstructions.map((instruction) => `- ${instruction}`)
      : ["- Only answer facts supported by the gathered sources."]),
    "",
    "Evidence quality:",
    `- search queries attempted: ${String(input.searchQueries.length)}`,
    `- source candidates gathered: ${String(input.sources.length)}`,
    `- fetched sources: ${String(fetchedSourceCount)}`,
    `- fetch failures: ${String(failedFetchCount)}`,
    fetchedSourceCount === 0
      ? "- no fetch_url call produced readable page text; rely only on snippets and be explicit about uncertainty."
      : "- prefer fetched page text over snippets when they conflict.",
    "",
    "Web tool results:",
  ].filter((line): line is string => line !== undefined);

  const failedSearches = input.searchResults.filter((entry) => !entry.result.success);
  if (input.searchResults.length > 0 && failedSearches.length === input.searchResults.length) {
    for (const entry of failedSearches) {
      lines.push(`web_search failed for "${entry.query}": ${entry.result.error?.message ?? "unknown error"}`);
    }
  } else if (input.sources.length === 0) {
    lines.push("web_search returned no results.");
  } else {
    input.sources.forEach((source, index) => appendWebSourceEvidence(lines, source, index));
  }

  return lines.join("\n");
}

export function buildWebAnswerRepairContext(input: {
  originalContext: string;
  invalidAnswer: string;
}): string {
  return [
    input.originalContext,
    "",
    "Previous answer was invalid because it contradicted the local tool execution.",
    "The CLI has controlled web capability and already attempted web_search/fetch_url for this turn.",
    "Rewrite the answer using the evidence above. Do not mention browser buttons, manual web switches, training-only knowledge, or that the CLI cannot network.",
    "If the gathered sources are insufficient, say the sources are insufficient to verify the requested current data.",
    "",
    "Invalid previous answer:",
    input.invalidAnswer,
  ].join("\n");
}

export function containsInvalidWebCapabilityDenial(text: string): boolean {
  return containsAnyText(text.toLowerCase(), [
    "没有联网能力", "不能联网", "无法联网", "不能自动联网", "没有实时联网", "默认是离线", "默认离线",
    "联网按钮", "联网开关", "开启联网", "手动开启联网", "插上网线", "只依赖训练", "training data only",
    "cannot browse", "cannot access the internet", "no internet access", "enable web browsing", "turn on web",
  ]);
}

export function buildLocalWebCapabilityCorrection(input: {
  searchQueryCount: number;
  sourceCount: number;
  fetchedSourceCount: number;
  sources: WebAnswerSource[];
}): string {
  const sourceLines = input.sources.slice(0, 4).map((source, index) => `${index + 1}. ${source.title} - ${source.url}`);

  return [
    "刚才的模型回答和工具记录冲突，已被本地 CLI 拦截。",
    "",
    "这个项目具备受控联网能力：本轮已经尝试调用 `web_search`，并按需调用 `fetch_url` 抓取公网页面。它不是浏览器式常驻联网，也没有需要手动点击的联网开关。",
    "",
    `本轮联网记录：搜索 ${String(input.searchQueryCount)} 次，获得候选来源 ${String(input.sourceCount)} 个，成功抓取页面 ${String(input.fetchedSourceCount)} 个。`,
    sourceLines.length > 0 ? `候选来源：\n${sourceLines.join("\n")}` : "没有拿到可用候选来源。",
    "",
    input.fetchedSourceCount > 0
      ? "请重新提问一次原问题，我会基于已修复的联网回答约束重新整理结果。"
      : "当前来源不足以核验具体实时数据，请换一个更明确的数据源或稍后重试。",
  ].join("\n");
}

function appendWebSourceEvidence(lines: string[], source: WebAnswerSource, index: number): void {
  lines.push("", `[source ${index + 1}] ${source.title}`);
  if (source.query) lines.push(`searchQuery: ${source.query}`);
  lines.push(`url: ${source.url}`);
  if (source.snippet) lines.push(`snippet: ${source.snippet}`);

  if (source.fetch) {
    lines.push(
      `fetchedUrl: ${source.fetch.finalUrl}`,
      `status: ${source.fetch.status}`,
      `contentType: ${source.fetch.contentType}`,
      `truncated: ${source.fetch.truncated || source.fetch.outputTruncated}`,
      "text:",
      limitText(source.fetch.text, 4_000),
    );
  } else if (source.fetchError) {
    lines.push(`fetch_url failed: ${source.fetchError}`);
  }
}

export function extractWebSources(searchResult: ToolResult<unknown>, query?: string): WebAnswerSource[] {
  if (!searchResult.success || !isWebSearchData(searchResult.data)) {
    return [];
  }

  return searchResult.data.results.map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    ...(query ? { query } : {}),
  }));
}

export function extractFetchedSource(fetchResult: ToolResult<unknown>): FetchedWebSource | undefined {
  if (!fetchResult.success || !isFetchUrlData(fetchResult.data)) {
    return undefined;
  }

  return {
    finalUrl: fetchResult.data.finalUrl,
    status: fetchResult.data.status,
    contentType: fetchResult.data.contentType,
    text: fetchResult.data.text,
    truncated: fetchResult.data.truncated,
    outputTruncated: fetchResult.data.outputTruncated,
  };
}

export function mergeWebSources(left: WebAnswerSource[], right: WebAnswerSource[]): WebAnswerSource[] {
  const seen = new Set(left.map((source) => normalizeUrlForDedupe(source.url)));
  const merged = [...left];

  for (const source of right) {
    const key = normalizeUrlForDedupe(source.url);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(source);
    }
  }

  return merged;
}

export function rankWebSources(
  sources: WebAnswerSource[],
  sourceHints: string[] = [],
  searchQueries: string[] = [],
): WebAnswerSource[] {
  return [...sources].sort((left, right) => scoreWebSource(right, sourceHints, searchQueries) - scoreWebSource(left, sourceHints, searchQueries));
}

export function selectWebSourcesForFetching(sources: WebAnswerSource[], limit: number): WebAnswerSource[] {
  const selected: WebAnswerSource[] = [];
  const deferred: WebAnswerSource[] = [];
  const seenHosts = new Set<string>();

  for (const source of sources) {
    const host = safeHostname(source.url);
    if (host && !seenHosts.has(host)) {
      seenHosts.add(host);
      selected.push(source);
    } else {
      deferred.push(source);
    }
  }

  return [...selected, ...deferred].slice(0, Math.max(0, limit));
}

export function isWebSearchData(value: unknown): value is {
  query: string;
  provider: string;
  results: Array<{ title: string; url: string; snippet: string }>;
} {
  if (!isRecord(value) || typeof value.provider !== "string" || !Array.isArray(value.results)) {
    return false;
  }

  return value.results.every((item) => isRecord(item)
    && typeof item.title === "string"
    && typeof item.url === "string"
    && typeof item.snippet === "string");
}

function scoreWebSource(source: WebAnswerSource, sourceHints: string[], searchQueries: string[]): number {
  const host = safeHostname(source.url) ?? "";
  const pathname = safePathname(source.url);
  const value = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
  const terms = buildWebSearchTerms(searchQueries);
  let score = 0;

  if (containsAnyText(value, ["fifa.com", "the-afc.com", "jfa.jp"])) score += 10;
  if (containsAnyText(value, ["espn", "bbc", "reuters", "apnews", "sofascore", "flashscore", "fotmob"])) score += 5;
  if (containsAnyText(host, ["github.com", "typescriptlang.org", "nodejs.org", "developer.mozilla.org", "npmjs.com"])) score += 7;
  if (host.endsWith(".gov") || host.endsWith(".edu")) score += 6;
  if (containsAnyText(value, ["score", "scores", "result", "results", "比分", "赛果", "赛程"])) score += 3;
  if (containsAnyText(value, ["official", "官网", "官方"])) score += 2;
  if (containsAnyText(`${host} ${pathname}`, ["docs", "developer", "support", "release", "releases", "changelog", "news", "blog", "announcement"])) score += 3;
  if (sourceHints.some((hint) => value.includes(hint.toLowerCase()))) score += 2;
  if (hasOfficialSourceHint(sourceHints) && containsAnyText(`${host} ${value}`, ["official", "官网", "官方", "docs", "developer", "support", "release", "changelog", ".gov", ".edu"])) score += 4;
  if (hasLiveScoreHint(sourceHints) && containsAnyText(value, ["sofascore", "flashscore", "fotmob", "espn", "score", "scores", "result", "results", "fixture", "fixtures"])) score += 4;
  if (hasReleaseHint(sourceHints) && containsAnyText(`${host} ${pathname} ${value}`, ["release", "releases", "changelog", "version", "update", "announcement", "blog", "docs"])) score += 3;
  score += Math.min(6, countMatchingTerms(value, terms));
  if (containsAnyText(host, ["reddit.com", "quora.com", "zhihu.com", "tieba.baidu.com", "weibo.com", "x.com", "twitter.com"])) score -= 4;
  if (containsAnyText(value, ["forum", "bbs", "贴吧", "社区讨论"])) score -= 2;
  if (source.fetch) score += 4;

  return score;
}

function buildWebSearchTerms(searchQueries: string[]): string[] {
  const stopWords = new Set([
    "the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "which",
    "latest", "current", "official", "site", "www", "com", "org", "net",
  ]);

  const tokens = searchQueries.flatMap((query) => query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !stopWords.has(part)));

  return [...new Set(tokens)];
}

function countMatchingTerms(value: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (value.includes(term) ? 1 : 0), 0);
}

function hasOfficialSourceHint(sourceHints: string[]): boolean {
  return sourceHints.some((hint) => /official|官网|官方/i.test(hint));
}

function hasLiveScoreHint(sourceHints: string[]): boolean {
  return sourceHints.some((hint) => /live score|fixture|results|scores?/i.test(hint));
}

function hasReleaseHint(sourceHints: string[]): boolean {
  return sourceHints.some((hint) => /release|changelog|update|公告|发布/i.test(hint));
}

function containsAnyText(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle.toLowerCase()));
}

function normalizeUrlForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function isFetchUrlData(value: unknown): value is FetchedWebSource {
  return isRecord(value)
    && typeof value.finalUrl === "string"
    && typeof value.status === "number"
    && typeof value.contentType === "string"
    && typeof value.text === "string"
    && typeof value.truncated === "boolean"
    && typeof value.outputTruncated === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}
