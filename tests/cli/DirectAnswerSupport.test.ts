import { describe, expect, it } from "vitest";
import { resolveLocalDirectReply } from "../../src/cli/DirectAnswerSupport.js";

describe("resolveLocalDirectReply product knowledge", () => {
  it("reports the configured model identifier instead of guessing", () => {
    expect(resolveLocalDirectReply(".", "whats ur model", { configuredModel: "gpt-test" }))
      .toContain("`gpt-test`");
  });

  it("uses the real product name", () => {
    expect(resolveLocalDirectReply(".", "你没有名字吗"))
      .toContain("Mini Coding Agent");
  });

  it("describes the actual processing paths without inventing a manual mode switch", () => {
    const reply = resolveLocalDirectReply(".", "你总共有几种对话模式");

    expect(reply).toContain("5 条主要处理路径");
    expect(reply).toContain("WEB_ANSWER");
    expect(reply).toContain("自动路由");
  });

  it("explains that web-answer is routed per request", () => {
    const reply = resolveLocalDirectReply(".", "你没有web-answer模式？");

    expect(reply).toContain("WEB_ANSWER");
    expect(reply).toContain("每条输入都会重新路由");
  });
});
