import { describe, expect, it } from "vitest";
import { planMemoryRead, planSessionMemoryWrite } from "../../src/memory/MemoryPolicy.js";
import type { SessionRecord } from "../../src/session/SessionTypes.js";

function summary(payload: SessionRecord["payload"]): SessionRecord {
  return {
    id: "record-1",
    type: "TASK_SUMMARY",
    timestamp: "2026-07-16T00:00:00.000Z",
    payload,
  };
}

describe("MemoryPolicy", () => {
  it("writes only successful AgentLoop outcomes backed by a repository diff", () => {
    expect(planSessionMemoryWrite(summary({ success: true, mode: "PLAN", summary: "done" })).store).toBe(false);
    expect(planSessionMemoryWrite(summary({ success: true, mode: "WEB_ANSWER", summary: "done" })).store).toBe(false);
    expect(planSessionMemoryWrite(summary({ success: true, mode: "AGENT_LOOP", summary: "done" })).store).toBe(false);

    expect(planSessionMemoryWrite(summary({
      success: true,
      mode: "AGENT_LOOP",
      summary: "修复上下文缓存错误",
      finalDiff: "+++ b/src/context/cache.ts\n@@ -1 +1 @@",
    }))).toMatchObject({
      store: true,
      kind: "ERROR_SOLUTION",
      scope: "REPOSITORY",
      evidenceRefs: ["file:src/context/cache.ts"],
    });
  });

  it("separates stable repository memory from explicit historical recall", () => {
    expect(planMemoryRead({ query: "实现新的 parser", mode: "AGENT_LOOP" })).toMatchObject({
      retrieve: true,
      allowedKinds: ["USER_PREFERENCE", "PROJECT_CONVENTION", "ARCHITECTURE_DECISION"],
      allowedScopes: ["REPOSITORY", "USER"],
    });
    expect(planMemoryRead({ query: "之前 parser 的错误怎么修的", mode: "DIRECT_ANSWER" })).toMatchObject({
      retrieve: true,
      allowedKinds: expect.arrayContaining(["VERIFIED_OUTCOME", "ERROR_SOLUTION"]),
    });
  });

  it("blocks ordinary direct answers, web paths, and knowledge-base requests", () => {
    expect(planMemoryRead({ query: "解释一下 TypeScript", mode: "DIRECT_ANSWER" }).retrieve).toBe(false);
    expect(planMemoryRead({ query: "某个网页问题", mode: "WEB_ANSWER" }).retrieve).toBe(false);
    expect(planMemoryRead({ query: "知识库里的退款规则", mode: "AGENT_LOOP", indexedKnowledgeRequest: true }).retrieve).toBe(false);
  });
});
