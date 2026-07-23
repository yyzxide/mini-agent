import {
  compactStructuredItems,
  type CompactionBucket,
} from "./StructuredCompactor.js";
import { estimateTokens } from "./TokenEstimator.js";

export interface MessageCompressorOptions {
  maxChars?: number;
  maxTokens?: number;
}

/**
 * Compatibility facade used by /compact. Automatic Session Memory compaction
 * and explicit compaction now share the structured-salience-v2 core.
 */
export class MessageCompressor {
  private readonly maxChars: number;
  private readonly maxTokens: number;

  constructor(options: MessageCompressorOptions = {}) {
    this.maxChars = options.maxChars ?? 30_000;
    this.maxTokens = options.maxTokens ?? Math.max(128, Math.floor(this.maxChars / 4));
  }

  compress(value: string): string {
    if (value.length <= this.maxChars && estimateTokens(value) <= this.maxTokens) {
      return value;
    }

    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return compactStructuredItems(
      lines.map((line, index) => {
        const bucket = classifyBucket(line);
        const { priority, reason } = classifyPriority(line);
        return {
          sourceId: `line-${String(index + 1)}`,
          content: line,
          bucket,
          priority,
          reason,
          order: index,
        };
      }),
      { maxChars: this.maxChars, maxTokens: this.maxTokens },
    ).text;
  }
}

function classifyBucket(line: string): CompactionBucket {
  if (
    /^\[(?:summary|error|memory)\]/i.test(line)
    || (/^\[user\]/i.test(line) && hasConstraint(line))
    || /^(?:goal|result|error|files?|tests?):/i.test(line)
  ) {
    return "PINNED";
  }
  if (/^\[(?:user|assistant)\]/i.test(line)) return "CONVERSATION";
  return "EVIDENCE";
}

function classifyPriority(line: string): { priority: number; reason: string } {
  if (/^\[error\]|^error:/i.test(line)) return { priority: 100, reason: "error evidence" };
  if (/^\[summary\]|^result:/i.test(line)) return { priority: 96, reason: "task outcome" };
  if (/^\[memory/i.test(line)) return { priority: 94, reason: "preserved memory" };
  if (/^\[user\]/i.test(line) && hasConstraint(line)) return { priority: 92, reason: "explicit user constraint" };
  if (/^\[user\]/i.test(line)) return { priority: 76, reason: "conversation request" };
  if (/^\[assistant\]/i.test(line)) return { priority: 68, reason: "conversation response" };
  if (/^(?:files?|tests?):/i.test(line)) return { priority: 64, reason: "task evidence" };
  return { priority: 48, reason: "recent transcript evidence" };
}

function hasConstraint(value: string): boolean {
  return /(?:不要|不得|不能|必须|只能|需要|应该|希望|倾向|优先|保持|避免|禁止|do not|don't|must|only|need|should|prefer|keep|avoid)/i.test(value);
}
