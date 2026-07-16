import { describe, expect, it } from "vitest";
import { ContextPlanner } from "../../src/context/ContextPlanner.js";

describe("ContextPlanner", () => {
  it("keeps required evidence and drops lower-priority optional sections under pressure", () => {
    const planner = new ContextPlanner({ maxChars: 700, maxTokens: 130 });
    const plan = planner.plan("RECOVERY", [
      {
        id: "task",
        title: "Task",
        content: "修复失败的上传测试",
        priority: 100,
        required: true,
        reason: "current goal",
      },
      {
        id: "failure",
        title: "Failure",
        content: `最新错误：checksum mismatch\n${"stack ".repeat(120)}`,
        priority: 99,
        required: true,
        maxTokens: 100,
        retention: "head_tail",
        reason: "latest failure",
      },
      {
        id: "readme",
        title: "README",
        content: "unrelated project introduction",
        priority: 10,
        reason: "low priority",
      },
    ]);

    expect(plan.context).toContain("修复失败的上传测试");
    expect(plan.context).toContain("checksum mismatch");
    expect(plan.trace.sections.find((section) => section.id === "task")?.selected).toBe(true);
    expect(plan.trace.sections.find((section) => section.id === "failure")?.selected).toBe(true);
    expect(plan.trace.sections.find((section) => section.id === "readme")?.selected).toBe(false);
    expect(plan.trace.totalChars).toBeLessThanOrEqual(700);
    expect(plan.trace.totalEstimatedTokens).toBeLessThanOrEqual(130);
  });
});
