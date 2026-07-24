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

  it("preserves a concise tool-call rationale", () => {
    expect(parser.parse(JSON.stringify({
      type: "TOOL_CALL",
      toolName: "read_file",
      input: { path: "src/index.ts" },
      reason: "Inspect the target before editing it",
    }))).toMatchObject({
      type: "TOOL_CALL",
      reason: "Inspect the target before editing it",
    });
  });

  it("parses bounded read-only delegation decisions", () => {
    expect(parser.parse(JSON.stringify({
      type: "delegate_readonly",
      reason: "Inspect independent concerns",
      tasks: [
        { id: "architecture", role: "repository_analyst", objective: "Map the loop", focusPaths: ["src/agent"] },
        { id: "risks", role: "risk_reviewer", objective: "Find concurrency risks", focusPaths: [] },
      ],
    }))).toMatchObject({
      type: "DELEGATE_READONLY",
      tasks: [{ id: "architecture" }, { id: "risks" }],
    });
  });

  it("parses implementation and dependent review delegation", () => {
    expect(parser.parse(JSON.stringify({
      type: "DELEGATE",
      reason: "Implement then review",
      tasks: [
        {
          id: "writer",
          role: "implementation_agent",
          objective: "Implement",
          focusPaths: ["src"],
          access: "PROPOSE_CHANGES",
          dependsOn: [],
        },
        {
          id: "reviewer",
          role: "change_reviewer",
          objective: "Review",
          focusPaths: ["src"],
          access: "REVIEW_CHANGES",
          dependsOn: ["writer"],
        },
      ],
    }))).toMatchObject({
      type: "DELEGATE",
      tasks: [
        { id: "writer", access: "PROPOSE_CHANGES" },
        { id: "reviewer", access: "REVIEW_CHANGES", dependsOn: ["writer"] },
      ],
    });
  });

  it("rejects duplicate or undersized delegation batches", () => {
    expect(() => parser.parse(JSON.stringify({
      type: "DELEGATE_READONLY",
      reason: "Too small",
      tasks: [{ id: "one", role: "repository_analyst", objective: "Inspect", focusPaths: [] }],
    }))).toThrow(/schema validation failed/);
    expect(() => parser.parse(JSON.stringify({
      type: "DELEGATE_READONLY",
      reason: "Duplicates",
      tasks: [
        { id: "same", role: "repository_analyst", objective: "Inspect A", focusPaths: [] },
        { id: "same", role: "risk_reviewer", objective: "Inspect B", focusPaths: [] },
      ],
    }))).toThrow(/schema validation failed/);
  });

  it("normalizes common model decision shape drift", () => {
    expect(parser.parse(JSON.stringify({
      type: "apply_patch",
      patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n",
      message: "write file",
    }))).toEqual({
      type: "APPLY_PATCH",
      patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n",
      description: "write file",
    });

    expect(parser.parse(JSON.stringify({
      type: "final",
      message: "done",
    }))).toEqual({
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

  it("rejects RUN_COMMAND decisions without executable", () => {
    expect(() => parser.parse('{"type":"RUN_COMMAND","description":"test"}')).toThrow(/missing executable/);
  });

  it("rejects shell RUN_COMMAND decisions without command", () => {
    expect(() => parser.parse('{"type":"RUN_COMMAND","shell":true,"description":"test"}')).toThrow(/missing command/);
  });
});
