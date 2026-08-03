const VECTOR_DIMENSIONS = 96;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "have",
  "will",
  "about",
  "一个",
  "这个",
  "那个",
  "我们",
  "你们",
  "他们",
  "已经",
  "可以",
  "需要",
  "什么",
  "如何",
  "是否",
  "怎么",
  "为什么",
]);

// The deterministic local embedding has no learned cross-language semantics.
// Expand only a small set of high-confidence repository terms so an exact
// concept still provides lexical evidence across Chinese and English. This is
// deliberately not a general translation layer: unknown terms continue to
// fail the lexical evidence gate instead of relying on hash collisions.
const CROSS_LANGUAGE_KEYWORD_GROUPS: readonly (readonly string[])[] = [
  ["upload", "uploads", "uploaded", "uploading", "上传"],
  ["download", "downloads", "downloaded", "downloading", "下载"],
  ["policy", "policies", "策略"],
  ["checksum", "checksums", "校验和", "校验"],
  ["verify", "verifies", "verified", "verifying", "verification", "验证", "校验"],
  ["validate", "validates", "validated", "validating", "validation", "验证", "校验"],
  ["permission", "permissions", "authorization", "authorize", "权限", "授权"],
  ["review", "reviews", "reviewed", "reviewing", "审核", "审查"],
  ["release", "releases", "released", "releasing", "发布"],
  ["test", "tests", "tested", "testing", "测试"],
  ["config", "configuration", "配置"],
  ["cache", "caches", "cached", "caching", "缓存"],
  ["security", "secure", "安全"],
];

const CROSS_LANGUAGE_KEYWORD_ALIASES = buildKeywordAliases(CROSS_LANGUAGE_KEYWORD_GROUPS);

export function extractKeywords(value: string): string[] {
  const normalized = value.toLowerCase();
  const asciiWords = normalized.match(/[a-z0-9_][a-z0-9_-]{1,}/g) ?? [];
  const cjkRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const tokens: string[] = [];

  for (const word of asciiWords) {
    if (!STOP_WORDS.has(word)) {
      tokens.push(word);
    }
  }

  for (const run of cjkRuns) {
    if (!STOP_WORDS.has(run)) {
      tokens.push(run);
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const gram = run.slice(index, index + 2);
      if (!STOP_WORDS.has(gram)) {
        tokens.push(gram);
      }
    }
  }

  return expandKeywordAliases(unique(tokens));
}

export function embedText(value: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  const keywords = extractKeywords(value);

  for (const keyword of keywords) {
    const hash = hashString(keyword);
    const index = hash % VECTOR_DIMENSIONS;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  const length = Math.sqrt(vector.reduce((total, item) => total + item * item, 0));
  if (length === 0) {
    return vector;
  }

  return vector.map((item) => item / length);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  const length = left.length;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildKeywordAliases(groups: readonly (readonly string[])[]): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const keyword of group) {
      const values = aliases.get(keyword) ?? new Set<string>();
      for (const alias of group) {
        if (alias !== keyword) values.add(alias);
      }
      aliases.set(keyword, values);
    }
  }
  return new Map([...aliases].map(([keyword, values]) => [keyword, [...values]]));
}

function expandKeywordAliases(keywords: string[]): string[] {
  return unique(keywords.flatMap((keyword) => [keyword, ...(CROSS_LANGUAGE_KEYWORD_ALIASES.get(keyword) ?? [])]));
}
