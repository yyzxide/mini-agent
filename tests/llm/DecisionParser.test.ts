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

  it("ignores non-JSON code blocks before a JSON decision", () => {
    expect(parser.parse([
      "I would run:",
      "```bash",
      "sudo apt update",
      "```",
      "{\"type\":\"PLAN\",\"message\":\"Use a safe decision instead\"}",
    ].join("\n"))).toEqual({
      type: "PLAN",
      message: "Use a safe decision instead",
    });
  });

  it("does not parse JSON-looking content inside non-JSON code blocks", () => {
    expect(() => parser.parse([
      "```bash",
      "echo '{\"type\":\"PLAN\",\"message\":\"not a decision\"}'",
      "```",
    ].join("\n"))).toThrow(/did not contain a JSON object/);
  });

  it("parses structured RUN_COMMAND decisions", () => {
    expect(parser.parse(JSON.stringify({
      type: "RUN_COMMAND",
      executable: "npm",
      args: ["test"],
      description: "Run tests",
    }))).toEqual({
      type: "RUN_COMMAND",
      executable: "npm",
      args: ["test"],
      shell: false,
      description: "Run tests",
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

  it("rejects RUN_COMMAND decisions without executable", () => {
    expect(() => parser.parse('{"type":"RUN_COMMAND","description":"test"}')).toThrow(/missing executable/);
  });

  it("rejects shell RUN_COMMAND decisions without command", () => {
    expect(() => parser.parse('{"type":"RUN_COMMAND","shell":true,"description":"test"}')).toThrow(/missing command/);
  });
});
