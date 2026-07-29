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

    expect(planSessionMemoryWrite(summary({
      success: true,
      mode: "AGENT_LOOP",
      summary: "更新缓存实现",
      artifactId: "artifact-1",
      changedFiles: ["src/context/cache.ts"],
    }))).toMatchObject({
      store: true,
      evidenceRefs: ["file:src/context/cache.ts"],
    });
  });

  it("separates stable repository memory from explicit historical recall", () => {
    expect(planMemoryRead({
      query: "实现新的 parser",
      repositoryWork: true,
      historicalRecall: false,
      webEvidence: false,
    })).toMatchObject({
      retrieve: true,
      allowedKinds: ["USER_PREFERENCE", "PROJECT_CONVENTION", "ARCHITECTURE_DECISION"],
      allowedScopes: ["REPOSITORY", "USER"],
    });
    expect(planMemoryRead({
      query: "继续处理 parser",
      resolvedQuery: "parser 的历史错误与修复",
      repositoryWork: false,
      historicalRecall: true,
      webEvidence: false,
    })).toMatchObject({
      retrieve: true,
      query: "parser 的历史错误与修复",
      allowedKinds: expect.arrayContaining(["VERIFIED_OUTCOME", "ERROR_SOLUTION"]),
    });
  });

  it("uses structured task facts to block ordinary, Web, and knowledge requests", () => {
    const ordinary = {
      repositoryWork: false,
      historicalRecall: false,
      webEvidence: false,
    };
    expect(planMemoryRead({ query: "解释一下 TypeScript", ...ordinary }).retrieve).toBe(false);
    expect(planMemoryRead({
      query: "某个网页问题",
      ...ordinary,
      webEvidence: true,
    }).retrieve).toBe(false);
    expect(planMemoryRead({
      query: "知识库里的退款规则",
      ...ordinary,
      indexedKnowledgeRequest: true,
    }).retrieve).toBe(false);
  });
});
