export interface MessageCompressorOptions {
  maxChars?: number;
}

export class MessageCompressor {
  private readonly maxChars: number;

  constructor(options: MessageCompressorOptions = {}) {
    this.maxChars = options.maxChars ?? 30_000;
  }

  compress(value: string): string {
    if (value.length <= this.maxChars) {
      return value;
    }

    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const important = unique(lines.filter((line) => /^(\[user\]|\[assistant\]|\[summary\]|\[memory|goal:|result:|error:|files?:|tests?:|decision:)/i.test(line)));
    const importantBudget = Math.floor(this.maxChars * 0.58);
    const importantText = takeWithinBudget(important, importantBudget);
    const header = [
      "[structured compaction]",
      "Key conversation facts:",
      importantText || "(none extracted)",
      "",
      "Recent context:",
    ].join("\n");
    const tailBudget = Math.max(0, this.maxChars - header.length - 1);
    return `${header}\n${value.slice(-tailBudget)}`.slice(0, this.maxChars);
  }
}

function takeWithinBudget(lines: string[], maxChars: number): string {
  const selected: string[] = [];
  let used = 0;
  for (const line of lines) {
    const nextLength = line.length + (selected.length > 0 ? 1 : 0);
    if (used + nextLength > maxChars) break;
    selected.push(line);
    used += nextLength;
  }
  return selected.join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
