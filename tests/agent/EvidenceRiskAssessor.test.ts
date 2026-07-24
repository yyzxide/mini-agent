import { describe, expect, it } from "vitest";
import { assessEvidenceRisk } from "../../src/agent/EvidenceRiskAssessor.js";

describe("EvidenceRiskAssessor", () => {
  it("escalates an ordinal relation even when the request classifier misses the domain", () => {
    const result = assessEvidenceRisk({
      userGoal: "黑神话悟空第三章boss是谁",
      draft: "第三章的最终 Boss 是黄眉。",
      now: new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(result.requiresVerification).toBe(true);
    expect(result.level).toBe("HIGH");
    expect(result.signals).toContain("bounded-relation");
  });

  it("detects stale scheduled-status claims against the runtime year", () => {
    const result = assessEvidenceRisk({
      userGoal: "这个游戏第三章boss是谁",
      draft: "游戏目前尚未正式发售，计划于2024年8月20日发布，因此没有官方信息。",
      now: new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(result.requiresVerification).toBe(true);
    expect(result.signals).toContain("runtime-date-contradiction");
    expect(result.signals).toContain("draft-strong-negative-or-universal");
  });

  it("raises evidence risk after a recent factual correction across domains", () => {
    const result = assessEvidenceRisk({
      userGoal: "那这家公司的创始人呢",
      draft: "这家公司成立于2016年，创始人是李明。",
      conversation: [
        { role: "user", content: "你刚才是不是编的？" },
        { role: "assistant", content: "我承认错误，刚才的内容没有核实。" },
      ],
    });

    expect(result.requiresVerification).toBe(true);
    expect(result.signals).toContain("recent-factual-correction");
    expect(result.signals).toContain("draft-exact-claim");
  });

  it("keeps broad definitions and explanations on the direct path", () => {
    const definition = assessEvidenceRisk({
      userGoal: "光合作用是什么？",
      draft: "光合作用是植物等生物把光能转化为化学能的过程。",
    });
    const explanation = assessEvidenceRisk({
      userGoal: "解释哈希表的工作原理",
      draft: "哈希表通过哈希函数把键映射到存储位置，并处理可能发生的冲突。",
    });

    expect(definition.requiresVerification).toBe(false);
    expect(explanation.requiresVerification).toBe(false);
  });

  it("does not turn local product or repository facts into web research", () => {
    const product = assessEvidenceRisk({
      userGoal: "这个助手能联网吗",
      draft: "本地能力注册表启用了受控联网研究工具。",
    });
    const repository = assessEvidenceRisk({
      userGoal: "修改 src/index.ts",
      draft: "我会先读取 src/index.ts，再提交补丁。",
    });
    const identity = assessEvidenceRisk({
      userGoal: "你是谁？",
      draft: "我是 Mini Coding Agent。",
    });

    expect(product.requiresVerification).toBe(false);
    expect(repository.requiresVerification).toBe(false);
    expect(identity.requiresVerification).toBe(false);
  });
});
