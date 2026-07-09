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
]);

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

  return unique(tokens);
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
  const length = Math.min(left.length, right.length);
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
