import { describe, expect, it } from "vitest";
import {
  buildAnswerQualityProfile,
  validateAnswerQuality,
} from "../../src/agent/AnswerQualityPolicy.js";

describe("AnswerQualityPolicy", () => {
  it("classifies answer shape independently from the subject domain", () => {
    expect(buildAnswerQualityProfile("什么是分布式锁").intent).toBe("DEFINITION");
    expect(buildAnswerQualityProfile("腾讯有多少子公司").intent).toBe("COUNT");
    expect(buildAnswerQualityProfile("列出三个常见排序算法").intent).toBe("ENUMERATION");
    expect(buildAnswerQualityProfile("某作品第三章boss是什么").intent).toBe("BOUNDED_RELATION");
    expect(buildAnswerQualityProfile("当前最新模型是什么").intent).toBe("BOUNDED_RELATION");
  });

  it("preserves explicit answer-depth requests", () => {
    expect(buildAnswerQualityProfile("一句话解释什么是哈希表").depth).toBe("BRIEF");
    expect(buildAnswerQualityProfile("详细解释什么是哈希表").depth).toBe("DETAILED");
    expect(buildAnswerQualityProfile("哈希表是什么").depth).toBe("BALANCED");
  });

  it("requires count answers to provide a number or a scoped limitation", () => {
    expect(validateAnswerQuality(
      "这家公司有多少子公司",
      "这家公司业务覆盖很多领域，详情请参考报告。",
    )).toMatchObject({ code: "FINAL_DOES_NOT_ANSWER_COUNT" });

    expect(validateAnswerQuality(
      "这家公司有多少子公司",
      "按照2025年年报的合并口径，共有42家子公司。",
    )).toBeUndefined();

    expect(validateAnswerQuality(
      "这家公司有多少子公司",
      "公开披露没有统一确切总数，因为统计结果取决于控股、参股以及合并范围的口径。",
    )).toBeUndefined();
  });

  it("requires definitions and enumerations to match their requested shape", () => {
    expect(validateAnswerQuality("什么是事件溯源", "事件溯源非常受欢迎。"))
      .toMatchObject({ code: "FINAL_DOES_NOT_DEFINE_SUBJECT" });
    expect(validateAnswerQuality(
      "什么是事件溯源",
      "事件溯源是一种通过追加领域事件来保存状态变化的方法。",
    )).toBeUndefined();

    expect(validateAnswerQuality("有哪些常见排序算法", "排序算法有很多。"))
      .toMatchObject({ code: "FINAL_DOES_NOT_ANSWER_ENUMERATION" });
    expect(validateAnswerQuality(
      "有哪些常见排序算法",
      "- 快速排序\n- 归并排序\n- 堆排序",
    )).toBeUndefined();
  });

  it("rejects source-only finals without imposing a raw minimum length", () => {
    expect(validateAnswerQuality("核实这个事实", "来源：https://example.com/source"))
      .toMatchObject({ code: "FINAL_WITHOUT_SUBSTANTIVE_ANSWER" });
    expect(validateAnswerQuality("法国的首都是什么", "巴黎。"))
      .toBeUndefined();
  });
});
