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

  it("describes document RAG separately from historical memory", () => {
    const reply = resolveLocalDirectReply(".", "你有rag系统吗");

    expect(reply).toContain("文档知识库 RAG");
    expect(reply).toContain("knowledge_search");
    expect(reply).toContain(".mini-agent/rag/index.jsonl");
    expect(reply).toContain(".mini-agent/memory/index.jsonl");
    expect(reply).toContain("不是把历史聊天记录换个名字叫 RAG");
  });

  it("assigns prompt and embedding caches to the correct infrastructure layers", () => {
    const reply = resolveLocalDirectReply(".", "缓存读写和命中是模型负责还是 agent 负责？");

    expect(reply).toContain("KV/Prompt Cache 由模型服务端维护");
    expect(reply).toContain("embedding 缓存由 Agent 基础设施维护");
    expect(reply).toContain(".mini-agent/cache/embeddings/v1/");
    expect(reply).toContain("不会直接缓存重放");
  });
});
