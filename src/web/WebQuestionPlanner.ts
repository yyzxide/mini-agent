import { z } from "zod";
import { formatRuntimeContext } from "../context/RuntimeContext.js";
import type { LlmTextResult } from "../llm/OpenAICompatibleClient.js";

export interface WebQuestionPlan {
  originalQuestion: string;
  standaloneQuestion: string;
  searchQueries: string[];
  answerScope: string;
  sourceHints: string[];
  answerInstructions: string[];
  needsLiveData: boolean;
  confidence: "high" | "medium" | "low";
  plannerError?: string;
}

export interface WebQuestionPlannerClient {
  completeText(input: {
    userGoal: string;
    context?: string | undefined;
    mode?: "direct" | "web" | "web_rewrite" | undefined;
  }): Promise<LlmTextResult>;
}

export interface PlanWebQuestionInput {
  userGoal: string;
  sessionMemory: string;
  client: WebQuestionPlannerClient;
}

const MAX_SEARCH_QUERIES = 4;

const webQuestionPlanSchema = z.object({
  standaloneQuestion: z.string().trim().min(1),
  searchQueries: z.array(z.string().trim().min(1)).min(1).max(MAX_SEARCH_QUERIES),
  answerScope: z.string().trim().min(1).default("Answer the current user question using the provided web evidence."),
  sourceHints: z.array(z.string().trim().min(1)).max(8).default([]),
  answerInstructions: z.array(z.string().trim().min(1)).max(10).default([]),
  needsLiveData: z.boolean().default(false),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});

type ParsedWebQuestionPlan = z.infer<typeof webQuestionPlanSchema>;

export async function planWebQuestion(input: PlanWebQuestionInput): Promise<WebQuestionPlan> {
  const fallback = buildFallbackWebQuestionPlan(input.userGoal, input.sessionMemory);
  const result = await input.client.completeText({
    userGoal: input.userGoal,
    context: buildPlannerContext(input.sessionMemory, fallback),
    mode: "web_rewrite",
  });

  if (!result.success || !result.text) {
    return {
      ...fallback,
      confidence: "low",
      plannerError: result.error ?? "Question planner returned no text",
    };
  }

  const parsed = parsePlannerJson(result.text);
  if (!parsed) {
    return {
      ...fallback,
      confidence: "low",
      plannerError: "Question planner returned invalid JSON",
    };
  }

  return normalizePlannerResult(input.userGoal, parsed, fallback);
}

export function buildFallbackWebQuestionPlan(userGoal: string, sessionMemory: string): WebQuestionPlan {
  const originalQuestion = normalizeSpaces(userGoal);
  const previousUserMessage = extractLastUserMessage(sessionMemory);
  const confirmedWebSwitch = previousUserMessage && isWebSwitchConfirmation(originalQuestion)
    ? previousUserMessage
    : undefined;
  const expandedFollowUp = previousUserMessage
    ? expandShortFollowUpQuestion(originalQuestion, previousUserMessage)
    : undefined;
  const shouldUsePreviousScope = previousUserMessage
    ? shouldCarryPreviousScope(originalQuestion, previousUserMessage)
    : false;
  const standaloneQuestion = confirmedWebSwitch
    ? confirmedWebSwitch
    : expandedFollowUp
    ? expandedFollowUp
    : shouldUsePreviousScope
    ? normalizeSpaces(`${previousUserMessage}；追问：${originalQuestion}`)
    : originalQuestion;
  const needsLiveData = isLikelyLiveOrCurrentQuestion(standaloneQuestion);
  const searchQueries = buildSearchQueries(standaloneQuestion, needsLiveData);
  const sourceHints = buildSourceHints(standaloneQuestion, needsLiveData);
  const answerInstructions = buildAnswerInstructions(standaloneQuestion, shouldUsePreviousScope, needsLiveData);

  return {
    originalQuestion,
    standaloneQuestion,
    searchQueries,
    answerScope: shouldUsePreviousScope
      ? "This is a follow-up question. Preserve the topic and scope from the previous user message unless the user clearly changed topic."
      : "Answer the current user question using the provided web evidence.",
    sourceHints,
    answerInstructions,
    needsLiveData,
    confidence: shouldUsePreviousScope || confirmedWebSwitch ? "medium" : "low",
  };
}

function isWebSwitchConfirmation(value: string): boolean {
  const compact = normalizeSpaces(value).toLowerCase().replace(/[\s,，。.!！？?;；:："“”'‘’、\-—()（）[\]【】]/g, "");
  return [
    "切换吧",
    "切到联网",
    "切换到联网",
    "联网查吧",
    "联网搜吧",
    "那就查吧",
    "那就搜吧",
    "用网页查吧",
    "你用搜一下",
    "用搜一下",
    "useweb",
    "switchtoweb",
    "searchonlinethen",
  ].some((phrase) => compact.includes(phrase));
}

export function extractLastUserMessage(sessionMemory: string): string | undefined {
  const matches = [...sessionMemory.matchAll(/^\[user\]\s+(.+)$/gm)];
  const latest = matches.at(-1)?.[1]?.trim();
  return latest && latest !== "(none)" ? latest : undefined;
}

export function resolveFollowUpQuestion(userGoal: string, sessionMemory: string): string | undefined {
  const previousUserMessage = extractLastUserMessage(sessionMemory);
  if (!previousUserMessage) {
    return undefined;
  }

  return expandShortFollowUpQuestion(userGoal, previousUserMessage);
}

function normalizePlannerResult(
  originalQuestion: string,
  parsed: ParsedWebQuestionPlan,
  fallback: WebQuestionPlan,
): WebQuestionPlan {
  const original = normalizeSpaces(originalQuestion);
  const fallbackResolvedContext = normalizeSpaces(fallback.standaloneQuestion) !== original;
  const standaloneQuestion = fallbackResolvedContext
    ? fallback.standaloneQuestion
    : normalizeSpaces(parsed.standaloneQuestion);
  const needsLiveData = parsed.needsLiveData || fallback.needsLiveData || isLikelyLiveOrCurrentQuestion(standaloneQuestion);
  const searchQueries = uniqueStrings([
    ...parsed.searchQueries,
    ...fallback.searchQueries,
    ...buildSearchQueries(standaloneQuestion, needsLiveData),
  ]).slice(0, MAX_SEARCH_QUERIES);

  return {
    originalQuestion: original,
    standaloneQuestion,
    searchQueries,
    answerScope: parsed.answerScope,
    sourceHints: uniqueStrings([...parsed.sourceHints, ...buildSourceHints(standaloneQuestion, needsLiveData)]).slice(0, 8),
    answerInstructions: uniqueStrings([
      ...parsed.answerInstructions,
      ...fallback.answerInstructions,
      ...buildAnswerInstructions(standaloneQuestion, false, needsLiveData),
    ]).slice(0, 10),
    needsLiveData,
    confidence: parsed.confidence,
  };
}

function buildPlannerContext(sessionMemory: string, fallback: WebQuestionPlan): string {
  return [
    "Runtime context:",
    formatRuntimeContext(),
    "",
    "Conversation memory:",
    sessionMemory,
    "",
    "Fallback plan:",
    JSON.stringify(fallback, null, 2),
    "",
    "Return JSON only. Do not answer the user question.",
  ].join("\n");
}

function parsePlannerJson(text: string): ParsedWebQuestionPlan | undefined {
  const trimmed = text.trim();
  const candidate = extractJsonObject(trimmed);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = webQuestionPlanSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function buildSearchQueries(standaloneQuestion: string, needsLiveData: boolean): string[] {
  const normalized = normalizeSpaces(standaloneQuestion);
  const lower = normalized.toLowerCase();
  const queries = [normalized];
  const additions: string[] = [];

  if (containsAnyText(lower, ["世界杯", "world cup"])) {
    additions.push("FIFA World Cup official results scores fixtures");
  }

  if (containsAnyText(lower, ["比分", "赛果", "成绩", "战绩", "比赛", "谁赢", "score", "scores", "result", "results", " vs ", "vs"])) {
    additions.push("live scores match results official");
  }

  if (containsAnyText(lower, ["版本", "发布", "更新", "latest", "release", "version"])) {
    additions.push("official release notes latest version");
  }

  if (containsAnyText(lower, ["新闻", "最新消息", "news"])) {
    additions.push("official news latest");
  }

  if (isLikelyFinancialMarketQuestion(normalized)) {
    additions.push("market close major indices change official finance");
  }

  if (isLikelyAmbiguousChampionQuestion(normalized)) {
    additions.push("honours championships multiple games categories");
  }

  if (needsLiveData) {
    additions.push("official live update");
  }

  if (additions.length > 0) {
    queries.push(`${normalized} ${uniqueStrings(additions).join(" ")}`);
  }

  queries.push(...buildSourceFocusedQueries(normalized, needsLiveData));

  return uniqueStrings(queries).slice(0, MAX_SEARCH_QUERIES);
}

function buildSourceFocusedQueries(standaloneQuestion: string, needsLiveData: boolean): string[] {
  const lower = standaloneQuestion.toLowerCase();
  const queries: string[] = [];

  if (containsAnyText(lower, ["世界杯", "world cup", "fifa", "足球", "比分", "赛果", "比赛", "谁赢", "score", "scores", "match", "team", "vs"])) {
    queries.push(`site:fifa.com ${standaloneQuestion} results scores fixtures`);
    queries.push(`site:espn.com soccer ${standaloneQuestion} results scores`);
    queries.push(`site:sofascore.com ${standaloneQuestion} live score`);
    queries.push(`site:flashscore.com ${standaloneQuestion} live score`);
  }

  if (isLikelyAmbiguousChampionQuestion(standaloneQuestion)) {
    queries.push(`${standaloneQuestion} honours championships League of Legends Valorant`);
    queries.push(`${standaloneQuestion} esports championships titles by game`);
    queries.push(`site:liquipedia.net ${standaloneQuestion} achievements`);
  }

  if (containsAnyText(lower, ["版本", "发布", "更新", "release", "version", "latest"])) {
    queries.push(`${standaloneQuestion} official release notes`);
    queries.push(`${standaloneQuestion} official changelog`);
    queries.push(`${standaloneQuestion} GitHub releases`);
  }

  if (containsAnyText(lower, ["政策", "法规", "法律", "policy", "law", "regulation"])) {
    queries.push(`${standaloneQuestion} official government source`);
  }

  if (isLikelyFinancialMarketQuestion(standaloneQuestion)) {
    queries.push(`${standaloneQuestion} 东方财富 新浪财经 上证指数 深证成指 创业板指 收盘`);
    queries.push(`${standaloneQuestion} 上交所 深交所 指数 收盘 涨跌`);
    queries.push(`site:finance.sina.com.cn ${standaloneQuestion} 上证指数 深证成指 创业板指`);
    queries.push(`site:quote.eastmoney.com ${standaloneQuestion} A股 大盘 指数`);
  }

  if (needsLiveData && queries.length === 0) {
    queries.push(`${standaloneQuestion} official latest update`);
  }

  return queries;
}

function buildSourceHints(standaloneQuestion: string, needsLiveData: boolean): string[] {
  const lower = standaloneQuestion.toLowerCase();
  const hints: string[] = ["official source", "recent source"];

  if (containsAnyText(lower, ["世界杯", "world cup", "比分", "赛果", "比赛", "谁赢", "score", "scores", "match", "vs"])) {
    hints.push("official competition site", "live score source", "fixture/results page");
  }

  if (isLikelyAmbiguousChampionQuestion(standaloneQuestion)) {
    hints.push("team honours page", "esports wiki", "official club/team page");
  }

  if (containsAnyText(lower, ["版本", "release", "version"])) {
    hints.push("official release notes", "project documentation");
  }

  if (isLikelyFinancialMarketQuestion(standaloneQuestion)) {
    hints.push("official exchange site", "major finance quote page", "market close summary");
  }

  if (needsLiveData) {
    hints.push("live or frequently updated page");
  }

  return uniqueStrings(hints);
}

function buildAnswerInstructions(
  standaloneQuestion: string,
  shouldUsePreviousScope: boolean,
  needsLiveData: boolean,
): string[] {
  const lower = standaloneQuestion.toLowerCase();
  const instructions = [
    "Only answer facts supported by the gathered sources.",
    "If sources are insufficient or cannot verify current data, say so clearly.",
  ];

  if (shouldUsePreviousScope) {
    instructions.push("This is a follow-up question; preserve the previous topic and scope.");
  }

  if (containsAnyText(lower, ["世界杯", "world cup", "比分", "赛果", "成绩", "战绩", "比赛", "谁赢", "score", "scores", "result", "results", "vs"])) {
    instructions.push("For sports results, keep competitions separate; do not mix friendlies, qualifiers, leagues, cups, or different tournaments unless the user asks for all competitions.");
  }

  if (isLikelyFinancialMarketQuestion(standaloneQuestion)) {
    instructions.push("For financial market data, distinguish index level, point change, percentage change, trading date, and whether the figure is intraday or closing data.");
    instructions.push("Do not give investment advice. If exact current close data is not verified by sources, say that clearly.");
  }

  if (isLikelyAmbiguousChampionQuestion(standaloneQuestion)) {
    instructions.push("If the entity is a multi-game team, organization, person, product, or acronym and the user did not specify a domain, do not assume one domain. List the main verified interpretations/categories and ask the user to specify if they need a narrower answer.");
    instructions.push("For esports teams, separate championships by game/title and tournament.");
  }

  if (needsLiveData) {
    instructions.push("For live/current data, distinguish verified latest facts from unavailable live data.");
  }

  return uniqueStrings(instructions);
}

export function isShortFollowUpQuestion(value: string): boolean {
  const normalized = normalizeSpaces(value);
  if (normalized.length === 0 || normalized.length > 24) {
    return false;
  }

  if (/^(那|那么|那如果|那要是|那对于|还有|然后)/.test(normalized)) {
    return true;
  }

  if (/(呢|咋样|怎么样|如何)([？?]?)$/.test(normalized)) {
    return true;
  }

  return normalized.length <= 8;
}

export function expandShortFollowUpQuestion(currentGoal: string, previousUserMessage: string): string | undefined {
  const current = normalizeSpaces(currentGoal);
  const previous = normalizeSpaces(previousUserMessage);
  if (!isShortFollowUpQuestion(current) || previous.length === 0) {
    return undefined;
  }

  const subject = extractFollowUpSubject(current);
  if (!subject) {
    return undefined;
  }

  const predicate = extractFollowUpPredicate(previous);
  if (!predicate) {
    return undefined;
  }

  return normalizeSpaces(`${subject}${predicate}`);
}

function shouldCarryPreviousScope(currentGoal: string, previousUserMessage: string): boolean {
  const current = currentGoal.toLowerCase();
  const previous = previousUserMessage.toLowerCase();
  const followUpSignals = [
    "最近",
    "这",
    "那",
    "上面",
    "刚才",
    "其",
    "他们",
    "它",
    "该",
    "这个",
    "那个",
    "he",
    "she",
    "they",
    "that",
    "those",
    "recent",
    "their",
    "its",
  ];

  if (containsAnyText(current, followUpSignals)) {
    return true;
  }

  return haveSharedDomain(current, previous);
}

function haveSharedDomain(current: string, previous: string): boolean {
  const domains = [
    ["世界杯", "world cup", "fifa", "足球", "比分", "赛果", "比赛", "score", "scores", "match", "team"],
    ["版本", "发布", "更新", "release", "version", "latest"],
    ["游戏", "宠物", "活动", "game", "event"],
    ["股票", "价格", "汇率", "price", "stock", "exchange rate"],
    ["政策", "法规", "法律", "policy", "law", "regulation"],
  ];

  return domains.some((domain) => containsAnyText(current, domain) && containsAnyText(previous, domain));
}

function isLikelyLiveOrCurrentQuestion(value: string): boolean {
  return containsAnyText(value.toLowerCase(), [
    "最新",
    "最近",
    "当前",
    "今天",
    "昨天",
    "现在",
    "实时",
    "比分",
    "赛果",
    "谁赢",
    "价格",
    "汇率",
    "新闻",
    "latest",
    "recent",
    "current",
    "today",
    "yesterday",
    "now",
    "live",
    "score",
    "scores",
    "price",
    "news",
  ]);
}

function isLikelyFinancialMarketQuestion(value: string): boolean {
  return containsAnyText(value.toLowerCase(), [
    "股市",
    "股票",
    "a股",
    "大盘",
    "指数",
    "上证",
    "深证",
    "创业板",
    "沪深",
    "收盘",
    "开盘",
    "涨跌",
    "涨幅",
    "跌幅",
    "行情",
    "证券",
    "汇率",
    "stock",
    "stocks",
    "stock market",
    "market index",
    "indices",
    "index",
    "market close",
    "closing price",
    "exchange rate",
  ]);
}

function extractFollowUpSubject(value: string): string | undefined {
  const normalized = normalizeSpaces(value)
    .replace(/^(那|那么|那如果|那要是|那对于|还有|然后)/, "")
    .replace(/(呢|咋样|怎么样|如何)([？?]?)$/, "")
    .replace(/[？?]+$/, "")
    .trim();

  return normalized.length > 0 ? normalized : undefined;
}

function extractFollowUpPredicate(previousUserMessage: string): string | undefined {
  const normalized = normalizeSpaces(previousUserMessage).replace(/[？?]+$/, "");
  const markerPatterns = [
    /^(?:.+?)(是.+)$/,
    /^(?:.+?)((?:世界杯|world cup).+)$/i,
    /^(?:.+?)((?:最新|latest).+)$/i,
    /^(?:.+?)((?:最近|recent).+)$/i,
    /^(?:.+?)(.*(?:比分|得分|赛果|成绩|战绩|score|scores|result|results).*)$/i,
    /^(?:.+?)(.*(?:强队|厉害|实力|怎么样|如何|冠军|夺冠|版本|发布|更新|新闻).*)$/i,
  ];

  for (const pattern of markerPatterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1] ? normalizeSpaces(match[1]) : "";
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function isLikelyAmbiguousChampionQuestion(value: string): boolean {
  const lower = value.toLowerCase();
  const asksChampion = containsAnyText(lower, [
    "冠军",
    "夺冠",
    "夺得",
    "获得冠军",
    "champion",
    "championship",
    "won",
    "winner",
    "title",
  ]);

  if (!asksChampion) {
    return false;
  }

  const hasExplicitDomain = containsAnyText(lower, [
    "英雄联盟",
    "league of legends",
    "lol",
    "无畏契约",
    "valorant",
    "王者荣耀",
    "csgo",
    "counter-strike",
    "dota",
    "世界杯",
    "world cup",
    "nba",
    "欧冠",
    "champions league",
  ]);

  if (hasExplicitDomain) {
    return false;
  }

  return /\b[a-z0-9]{2,8}\b/i.test(value) || containsAnyText(lower, ["战队", "俱乐部", "team", "club", "organization", "org"]);
}

function containsAnyText(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle.toLowerCase()));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values.map(normalizeSpaces).filter((item) => item.length > 0)) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
