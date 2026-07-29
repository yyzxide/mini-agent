export interface WebQueryScopeViolation {
  code: "WEB_QUERY_SCOPE_STRENGTHENED";
  message: string;
}

export interface HigherNamedVersionCandidate {
  family: string;
  claimed: string;
  candidate: string;
}

/**
 * Search queries may add synonyms for recall, but must not silently strengthen
 * the TaskFrame's representative scope into a ranking/superlative request.
 * Natural-language intent is compiled upstream; this function validates only
 * the model-proposed query against that structured policy.
 */
export function validateWebSearchQueryScope(
  ranking: "REPRESENTATIVE" | "SUPERLATIVE",
  query: string,
): WebQueryScopeViolation | undefined {
  const candidate = normalize(query);
  if (
    !candidate
    || ranking === "SUPERLATIVE"
    || !hasRankingSuperlative(candidate)
  ) {
    return undefined;
  }

  return {
    code: "WEB_QUERY_SCOPE_STRENGTHENED",
    message: [
      "Search query scope was strengthened beyond the user's request.",
      "Preserve representative qualifiers such as 知名/famous/notable without adding 最/most/top/best/greatest.",
      "Use the user's original entity and scope in the next web_search query; extra synonym queries may broaden recall but must not introduce a ranking requirement.",
    ].join(" "),
  };
}

export function looksLikeAuthoritativeFreshnessQuery(value: string): boolean {
  const text = normalize(value);
  const authority = /(?:官方|官网|发布页|发布说明|更新日志)|\b(?:official|primary source|release notes?|changelog)\b|\bsite:\s*[a-z0-9.-]+/i.test(text);
  return authority && looksLikeFreshnessIntent(text);
}

/**
 * A dated query is a freshness query even when the model omitted a literal
 * "latest" synonym. The year is only retrieval intent; it is never treated as
 * proof that a returned result is current.
 */
export function looksLikeFreshnessIntent(
  value: string,
  currentYear = new Date().getFullYear(),
): boolean {
  const text = normalize(value);
  if (/(?:最新|当前|现在|发布|版本|型号|更新)|\b(?:latest|current|newest|release|version|model|updated?)\b/i.test(text)) {
    return true;
  }

  return [...text.matchAll(/\b((?:19|20)\d{2})\b/g)]
    .some((match) => {
      const year = Number(match[1]);
      return year >= currentYear - 1 && year <= currentYear + 1;
    });
}

export function extractSiteConstraintDomains(value: string): string[] {
  const domains = [...normalize(value).matchAll(/\bsite:\s*([a-z0-9.-]+\.[a-z]{2,})\b/gi)]
    .map((match) => normalizeHostname(match[1] ?? ""))
    .filter((domain) => domain.length > 0);
  return [...new Set(domains)];
}

export function urlMatchesSiteConstraint(url: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  try {
    const hostname = normalizeHostname(new URL(url).hostname);
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * A temporal superlative cannot be supported by evidence that visibly contains
 * a higher version from the same named family. This does not prove the higher
 * version is released; it forces the Agent to investigate the candidate before
 * making a confident "latest" claim.
 */
export function findHigherNamedVersionCandidate(
  summary: string,
  evidenceTexts: string[],
): HigherNamedVersionCandidate | undefined {
  const claims = latestVersionByFamily(extractNamedVersions(summary));
  if (claims.size === 0) return undefined;
  const evidence = latestVersionByFamily(evidenceTexts.flatMap(extractNamedVersions));

  for (const [family, claim] of claims) {
    const candidate = evidence.get(family);
    if (candidate && compareVersionParts(candidate.parts, claim.parts) > 0) {
      return {
        family,
        claimed: claim.label,
        candidate: candidate.label,
      };
    }
  }
  return undefined;
}

function hasRankingSuperlative(value: string): boolean {
  return /(?:最(?:知名|著名|有名|热门|受欢迎|经典|佳|好|伟大)|顶级|排名(?:最高|前)|前\s*\d+\s*(?:名|首|个)?)|\b(?:most (?:famous|notable|popular|well[- ]known|successful)|top(?:\s+\d+)?|best|greatest)\b/i
    .test(value);
}

interface NamedVersion {
  family: string;
  label: string;
  parts: number[];
}

function extractNamedVersions(value: string): NamedVersion[] {
  return [...value.matchAll(/\b([a-z][a-z0-9]{1,20})[\s_./\-\u2010-\u2015]?(\d+\.\d+(?:\.\d+)?)\b/gi)]
    .map((match) => ({
      family: (match[1] ?? "").toLowerCase(),
      label: `${match[1] ?? ""}-${match[2] ?? ""}`,
      parts: (match[2] ?? "").split(".").map(Number),
    }))
    .filter((version) => version.family.length > 0 && version.parts.every(Number.isFinite));
}

function latestVersionByFamily(versions: NamedVersion[]): Map<string, NamedVersion> {
  const latest = new Map<string, NamedVersion>();
  for (const version of versions) {
    const current = latest.get(version.family);
    if (!current || compareVersionParts(version.parts, current.parts) > 0) {
      latest.set(version.family, version);
    }
  }
  return latest;
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
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
}
