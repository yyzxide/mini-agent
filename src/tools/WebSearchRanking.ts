export interface RankableWebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface ScoredResult<T extends RankableWebSearchResult> {
  result: T;
  originalIndex: number;
  score: number;
}

const TEMPORAL_QUERY_PATTERN = /(?:最新|当前|现在|近期|最近|刚刚|本周|本月|今年)|\b(?:latest|current|currently|newest|recent|today|this (?:week|month|year))\b/i;
const RELEASE_PATH_PATTERN = /\/(?:index|news|blog|release|releases|changelog|updates?|models?)(?:\/|$)/i;
const QUERY_STOP_WORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on",
  "latest", "current", "currently", "newest", "recent", "today",
  "model", "models", "release", "releases", "official", "what", "is",
]);

/**
 * Search-engine rank is retrieval evidence, not a freshness guarantee.
 * For temporal queries, rerank the complete parsed candidate pool using
 * first-party-domain affinity, publication dates, release-like paths, and
 * comparable named versions before applying the caller's result limit.
 */
export function rankWebSearchResults<T extends RankableWebSearchResult>(
  results: T[],
  query: string,
): T[] {
  if (results.length < 2 || !TEMPORAL_QUERY_PATTERN.test(query)) {
    return results.slice();
  }

  const queryTokens = extractQueryTokens(query);
  const entityTokens = queryTokens.filter((token) => !QUERY_STOP_WORDS.has(token) && !/^\d+$/.test(token));
  const datedCandidates = results
    .map((result) => extractLatestDate(`${result.title} ${result.snippet}`))
    .filter((value): value is number => value !== undefined);
  const latestCandidateDate = datedCandidates.length > 0 ? Math.max(...datedCandidates) : undefined;
  const latestVersions = collectLatestNamedVersions(results);

  const scored: Array<ScoredResult<T>> = results.map((result, originalIndex) => {
    const title = normalize(result.title);
    const snippet = normalize(result.snippet);
    const hostname = readHostname(result.url);
    const searchableUrl = normalize(result.url);
    const titleMatches = countMatches(title, queryTokens);
    const snippetMatches = countMatches(snippet, queryTokens);
    const urlMatches = countMatches(searchableUrl, queryTokens);
    const firstPartyAffinity = entityTokens.some((token) => hostnameTokenMatches(hostname, token));
    const date = extractLatestDate(`${result.title} ${result.snippet}`);
    const namedVersions = extractNamedVersions(`${result.title} ${result.snippet} ${result.url}`);

    let score = titleMatches * 4 + snippetMatches + urlMatches * 2 - originalIndex * 0.05;
    if (firstPartyAffinity) score += 12;
    if (RELEASE_PATH_PATTERN.test(readPathname(result.url))) score += 3;
    if (date !== undefined && latestCandidateDate !== undefined) {
      const ageDays = Math.max(0, (latestCandidateDate - date) / 86_400_000);
      score += Math.max(0, 8 - Math.min(8, ageDays / 30));
    }
    if (namedVersions.some((version) => (
      compareVersionParts(version.parts, latestVersions.get(version.family) ?? []) === 0
    ))) {
      score += 6;
    }

    return { result, originalIndex, score };
  });

  return scored
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
    .map((entry) => entry.result);
}

export function isTemporalSearchQuery(query: string): boolean {
  return TEMPORAL_QUERY_PATTERN.test(query);
}

function extractQueryTokens(value: string): string[] {
  return [...new Set(
    normalize(value)
      .split(/[^\p{L}\p{N}.+-]+/u)
      .map((token) => token.replace(/^[.+-]+|[.+-]+$/g, ""))
      .filter((token) => token.length >= 2),
  )];
}

function countMatches(value: string, tokens: string[]): number {
  return tokens.reduce((count, token) => count + (value.includes(token) ? 1 : 0), 0);
}

function hostnameTokenMatches(hostname: string, token: string): boolean {
  const compactToken = token.replace(/[^a-z0-9]/g, "");
  if (compactToken.length < 3) return false;
  return hostname
    .split(".")
    .some((label) => label.replace(/[^a-z0-9]/g, "").includes(compactToken));
}

function readHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function readPathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function extractLatestDate(value: string): number | undefined {
  const dates: number[] = [];
  for (const match of value.matchAll(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g)) {
    dates.push(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  for (const match of value.matchAll(/\b(20\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日/g)) {
    dates.push(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  const monthNames = "january|february|march|april|may|june|july|august|september|october|november|december";
  const englishPattern = new RegExp(`\\b(${monthNames})\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "gi");
  for (const match of value.matchAll(englishPattern)) {
    const month = monthNameToIndex(match[1] ?? "");
    if (month >= 0) dates.push(Date.UTC(Number(match[3]), month, Number(match[2])));
  }
  return dates.length > 0 ? Math.max(...dates) : undefined;
}

function monthNameToIndex(value: string): number {
  return [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ].indexOf(value.toLowerCase());
}

interface NamedVersion {
  family: string;
  parts: number[];
}

function collectLatestNamedVersions(results: RankableWebSearchResult[]): Map<string, number[]> {
  const latest = new Map<string, number[]>();
  for (const result of results) {
    for (const version of extractNamedVersions(`${result.title} ${result.snippet} ${result.url}`)) {
      const current = latest.get(version.family);
      if (!current || compareVersionParts(version.parts, current) > 0) {
        latest.set(version.family, version.parts);
      }
    }
  }
  return latest;
}

function extractNamedVersions(value: string): NamedVersion[] {
  return [...value.matchAll(/\b([a-z][a-z0-9]{1,20})[-\s_/]?(\d+\.\d+(?:\.\d+)?)\b/gi)]
    .map((match) => ({
      family: (match[1] ?? "").toLowerCase(),
      parts: (match[2] ?? "").split(".").map(Number),
    }))
    .filter((version) => version.family.length > 0 && version.parts.every(Number.isFinite));
}

function compareVersionParts(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
