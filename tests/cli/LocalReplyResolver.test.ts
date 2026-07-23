import { describe, expect, it } from "vitest";
import {
  resolveLocalDirectReply,
  resolveLocalSessionReply,
} from "../../src/cli/LocalReplyResolver.js";
import type { SessionRecord } from "../../src/session/SessionTypes.js";

describe("resolveLocalDirectReply product knowledge", () => {
  it("reports the configured model identifier instead of guessing", () => {
    expect(resolveLocalDirectReply(".", "whats ur model", { configuredModel: "gpt-test" }))
      .toContain("`gpt-test`");
  });

  it("uses the real product name", () => {
    expect(resolveLocalDirectReply(".", "你没有名字吗"))
      .toContain("Mini Coding Agent");
  });

  it("describes the unified runtime and task contracts", () => {
    const reply = resolveLocalDirectReply(".", "你总共有几种对话模式");

    expect(reply).toContain("一个统一的 `AgentLoop`");
    expect(reply).toContain("任务契约");
    expect(reply).toContain("不是独立 Agent");
  });

  it("explains that web research is an AgentLoop contract", () => {
    const reply = resolveLocalDirectReply(".", "你没有web-answer模式？");

    expect(reply).toContain("WEB_RESEARCH");
    expect(reply).toContain("统一 `AgentLoop`");
    expect(reply).toContain("不是独立执行器");
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

  it("describes overall capabilities without treating the direct contract as a global limitation", () => {
    const reply = resolveLocalDirectReply(".", "你可以干啥");

    expect(reply).toContain("web_search");
    expect(reply).toContain("仓库文件修改");
    expect(reply).toContain("apply_patch");
    expect(reply).toContain("不代表整个产品缺少它");
    expect(reply).not.toContain("不能修改文件");
    expect(reply).not.toContain("不能上网搜索");
  });

  it("answers file-write capability questions from product facts", () => {
    const reply = resolveLocalDirectReply(".", "你不能写文件吗？");

    expect(reply).toContain("支持仓库文件修改");
    expect(reply).toContain("REPOSITORY_TASK");
    expect(reply).toContain("apply_patch");
  });

  it("explains a prior false web denial from local session evidence", () => {
    const records: SessionRecord[] = [
      {
        id: "answer",
        sessionId: "session",
        type: "ASSISTANT_MESSAGE",
        timestamp: "2026-07-23T00:00:00.000Z",
        payload: { content: "当前任务不能上网搜索。" },
      },
    ];
    const reply = resolveLocalSessionReply("那你为什么说自己不能联网？", records);

    expect(reply).toContain("上一轮回答错了");
    expect(reply).toContain("Capability Registry 才是权威事实源");
    expect(reply).toContain("不应该为了证明联网能力");
    expect(reply).toContain("搜索天气");
  });
});
