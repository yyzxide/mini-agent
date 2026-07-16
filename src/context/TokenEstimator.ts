import type { ContextRetention } from "./ContextTypes.js";

const CJK_PATTERN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

export function estimateTokens(value: string): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of value) {
    if (CJK_PATTERN.test(char)) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return cjkChars + Math.ceil(otherChars / 4);
}

export function truncateToTokenBudget(
  value: string,
  maxTokens: number,
  retention: ContextRetention = "head",
): { text: string; truncated: boolean } {
  if (maxTokens <= 0) {
    return { text: "", truncated: value.length > 0 };
  }
  if (estimateTokens(value) <= maxTokens) {
    return { text: value, truncated: false };
  }

  const marker = "\n...[context truncated]...\n";
  const contentBudget = Math.max(1, maxTokens - estimateTokens(marker));
  if (retention === "tail") {
    return { text: `${marker.trimStart()}${takeTail(value, contentBudget)}`, truncated: true };
  }
  if (retention === "head_tail") {
    const headBudget = Math.max(1, Math.floor(contentBudget * 0.4));
    const tailBudget = Math.max(1, contentBudget - headBudget);
    return {
      text: `${takeHead(value, headBudget)}${marker}${takeTail(value, tailBudget)}`,
      truncated: true,
    };
  }
  return { text: `${takeHead(value, contentBudget)}${marker.trimEnd()}`, truncated: true };
}

function takeHead(value: string, maxTokens: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(value.slice(0, middle)) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function takeTail(value: string, maxTokens: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (estimateTokens(value.slice(-length)) <= maxTokens) {
      low = length;
    } else {
      high = length - 1;
    }
  }
  return value.slice(-low);
}
