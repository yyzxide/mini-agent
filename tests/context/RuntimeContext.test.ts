import { describe, expect, it } from "vitest";
import { formatRuntimeContext, getRuntimeContext } from "../../src/context/RuntimeContext.js";

describe("RuntimeContext", () => {
  it("formats trusted local date and time facts", () => {
    const context = getRuntimeContext({
      now: new Date("2026-06-30T12:34:56.000Z"),
      timeZone: "Asia/Shanghai",
    });

    expect(context).toEqual({
      currentDate: "2026-06-30",
      currentTime: "20:34:56",
      timeZone: "Asia/Shanghai",
      utcOffset: "UTC+08:00",
      utcTimestamp: "2026-06-30T12:34:56.000Z",
    });
    expect(formatRuntimeContext(context)).toContain("Current local date: 2026-06-30");
    expect(formatRuntimeContext(context)).toContain("Use this runtime context as the source of truth");
  });
});
