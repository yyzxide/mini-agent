import { describe, expect, it } from "vitest";
import { MessageCompressor } from "../../src/context/MessageCompressor.js";

describe("MessageCompressor", () => {
  it("keeps short context unchanged", () => {
    expect(new MessageCompressor({ maxChars: 100 }).compress("short context")).toBe("short context");
  });

  it("preserves key conversation facts and recent context under budget", () => {
    const value = [
      "[user] implement memory support",
      "[assistant] agreed to add explicit remember and forget",
      ...Array.from({ length: 30 }, (_, index) => `tool noise ${index} ${"x".repeat(30)}`),
      "error: one transient failure",
      "[user] finish the implementation",
    ].join("\n");
    const compressed = new MessageCompressor({ maxChars: 400 }).compress(value);
    expect(compressed).toContain("[structured session compaction v2]");
    expect(compressed).toContain("[user] implement memory support");
    expect(compressed).toContain("[user] finish the implementation");
    expect(compressed).toContain("source:line-");
    expect(compressed.length).toBeLessThanOrEqual(400);
  });
});
