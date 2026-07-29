import { describe, expect, it } from "vitest";
import {
  buildAnswerQualityProfile,
  validateAnswerQuality,
} from "../../src/agent/AnswerQualityPolicy.js";
import { createTestTaskFrame } from "../helpers/TaskFrameContract.js";

describe("AnswerQualityPolicy", () => {
  it("consumes the model-authored answer shape", () => {
    expect(profile("DEFINITION").intent).toBe("DEFINITION");
    expect(profile("COUNT").intent).toBe("COUNT");
    expect(profile("ENUMERATION").intent).toBe("ENUMERATION");
    expect(profile("RELATION").intent).toBe("BOUNDED_RELATION");
  });

  it("preserves the model-authored answer depth", () => {
    expect(profile("FREEFORM", "BRIEF").depth).toBe("BRIEF");
    expect(profile("FREEFORM", "DETAILED").depth).toBe("DETAILED");
    expect(profile("FREEFORM", "BALANCED").depth).toBe("BALANCED");
  });

  it("requires count answers to provide a number or a scoped limitation", () => {
    expect(validateAnswerQuality(
      "这家公司业务覆盖很多领域，详情请参考报告。",
      frame("COUNT"),
    )).toMatchObject({ code: "FINAL_DOES_NOT_ANSWER_COUNT" });

    expect(validateAnswerQuality(
      "按照2025年年报的合并口径，共有42家子公司。",
      frame("COUNT"),
    )).toBeUndefined();

    expect(validateAnswerQuality(
      "公开披露没有统一确切总数，因为统计结果取决于控股、参股以及合并范围的口径。",
      frame("COUNT"),
    )).toBeUndefined();
  });

  it("requires definitions and enumerations to match their requested shape", () => {
    expect(validateAnswerQuality("事件溯源非常受欢迎。", frame("DEFINITION")))
      .toMatchObject({ code: "FINAL_DOES_NOT_DEFINE_SUBJECT" });
    expect(validateAnswerQuality(
      "事件溯源是一种通过追加领域事件来保存状态变化的方法。",
      frame("DEFINITION"),
    )).toBeUndefined();

    expect(validateAnswerQuality("排序算法有很多。", frame("ENUMERATION")))
      .toMatchObject({ code: "FINAL_DOES_NOT_ANSWER_ENUMERATION" });
    expect(validateAnswerQuality(
      "- 快速排序\n- 归并排序\n- 堆排序",
      frame("ENUMERATION"),
    )).toBeUndefined();
  });

  it("rejects source-only finals without imposing a raw minimum length", () => {
    expect(validateAnswerQuality("来源：https://example.com/source", frame("FREEFORM")))
      .toMatchObject({ code: "FINAL_WITHOUT_SUBSTANTIVE_ANSWER" });
    expect(validateAnswerQuality("巴黎。", frame("FREEFORM")))
      .toBeUndefined();
  });
});

function frame(
  shape: Parameters<typeof createTestTaskFrame>[0]["answer"] extends infer _Value
    ? "DEFINITION" | "COUNT" | "ENUMERATION" | "RELATION" | "IDENTITY" | "EXPLANATION" | "FREEFORM"
    : never,
  depth: "BRIEF" | "BALANCED" | "DETAILED" = "BALANCED",
) {
  return createTestTaskFrame({
    objective: "test answer",
    answer: { shape, depth },
  });
}

function profile(
  shape: Parameters<typeof frame>[0],
  depth: Parameters<typeof frame>[1] = "BALANCED",
) {
  return buildAnswerQualityProfile(frame(shape, depth));
}
