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

    return [
      "[truncated]",
      value.slice(value.length - this.maxChars),
    ].join("\n");
  }
}
