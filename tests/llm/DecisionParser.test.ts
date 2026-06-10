import { describe, expect, it } from "vitest";
import { DecisionParser } from "../../src/llm/DecisionParser.js";

describe("DecisionParser", () => {
  const parser = new DecisionParser();

  it("parses plain JSON", () => {
    expect(parser.parse('{"type":"PLAN","message":"Search first"}')).toEqual({
      type: "PLAN",
      message: "Search first",
    });
  });

  it("parses JSON code blocks", () => {
    expect(parser.parse("```json\n{\"type\":\"ASK_USER\",\"message\":\"Which file?\"}\n```")).toEqual({
      type: "ASK_USER",
      message: "Which file?",
    });
  });

  it("parses JSON surrounded by extra text", () => {
    expect(parser.parse("next step:\n{\"type\":\"FINAL\",\"summary\":\"done\",\"success\":true}\nthanks")).toEqual({
      type: "FINAL",
      summary: "done",
      success: true,
    });
  });

  it("rejects unknown decision types", () => {
    expect(() => parser.parse('{"type":"NOPE"}')).toThrow(/Unknown AgentDecision type/);
  });

  it("rejects TOOL_CALL decisions without toolName", () => {
    expect(() => parser.parse('{"type":"TOOL_CALL","input":{}}')).toThrow(/missing toolName/);
  });

  it("rejects APPLY_PATCH decisions without patch", () => {
    expect(() => parser.parse('{"type":"APPLY_PATCH","description":"change file"}')).toThrow(/missing patch/);
  });

  it("rejects RUN_COMMAND decisions without command", () => {
    expect(() => parser.parse('{"type":"RUN_COMMAND","description":"test"}')).toThrow(/missing command/);
  });
});
