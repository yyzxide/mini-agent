import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyReviewVerification,
  buildLoadedReviewFile,
  extractRelatedReviewFilePaths,
  extractLikelyReviewFilePath,
  groundCodeReviewResponse,
  looksLikeReviewableFilePath,
} from "../../src/review/CodeReview.js";

describe("CodeReview helpers", () => {
  it("detects likely review file paths", () => {
    expect(looksLikeReviewableFilePath("src/tools/WebSearchTool.ts")).toBe(true);
    expect(looksLikeReviewableFilePath("/home/sid/demo/App.java")).toBe(true);
    expect(looksLikeReviewableFilePath("not-a-file")).toBe(false);
    expect(extractLikelyReviewFilePath("请检查 `src/tools/WebSearchTool.ts` 有没有 bug")).toBe("src/tools/WebSearchTool.ts");
  });

  it("filters findings that are not grounded in the loaded file", () => {
    const file = buildLoadedReviewFile([
      {
        path: "src/tools/WebSearchTool.ts",
        startLine: 1,
        endLine: 4,
        totalLines: 4,
        content: [
          "function decodeHtmlEntities(text: string): string {",
          "  return text.replace(/&#(\\d+);/g, () => \"\");",
          "}",
          "",
        ].join("\n"),
      },
    ]);

    const grounded = groundCodeReviewResponse({
      summary: "Found one issue.",
      overallVerdict: "issues_found",
      findings: [
        {
          severity: "medium",
          certainty: "confirmed",
          file: "src/tools/WebSearchTool.ts",
          line: 2,
          title: "Decimal entities only",
          codeQuote: "return text.replace(/&#(\\d+);/g, () => \"\");",
          reasoning: "Only decimal entities are handled.",
        },
        {
          severity: "high",
          certainty: "confirmed",
          file: "src/tools/WebSearchTool.ts",
          line: 2,
          title: "Hallucinated finding",
          codeQuote: "doesNotExist();",
          reasoning: "This quote is not present.",
        },
      ],
      followUp: [],
    }, file);

    expect(grounded.findings).toHaveLength(1);
    expect(grounded.findings[0]?.title).toBe("Decimal entities only");
    expect(grounded.rejectedFindings).toHaveLength(1);
  });

  it("applies verification to drop overreaching findings", () => {
    const file = buildLoadedReviewFile([
      {
        path: "src/tools/WebSearchTool.ts",
        startLine: 1,
        endLine: 3,
        totalLines: 3,
        content: [
          "function decodeHtmlEntities(text: string): string {",
          "  return text.replace(/&#(\\d+);/g, () => \"\");",
          "}",
        ].join("\n"),
      },
    ]);

    const grounded = groundCodeReviewResponse({
      summary: "Found one issue.",
      overallVerdict: "issues_found",
      findings: [
        {
          severity: "medium",
          certainty: "confirmed",
          file: "src/tools/WebSearchTool.ts",
          line: 2,
          title: "Decimal entities only",
          codeQuote: "return text.replace(/&#(\\d+);/g, () => \"\");",
          reasoning: "Only decimal entities are handled.",
        },
      ],
      followUp: [],
    }, file);

    const verified = applyReviewVerification(grounded, {
      summary: "The claim is too strong for the available code.",
      findings: [
        {
          index: 0,
          keep: false,
          certainty: "possible",
          reasoning: "The available file alone does not prove a user-visible bug.",
          dropReason: "The finding overstates impact without showing an actual failing caller or unsupported input requirement.",
        },
      ],
      followUp: ["Check whether hex entities appear in real search results before calling this a bug."],
    });

    expect(verified.findings).toHaveLength(0);
    expect(verified.rejectedFindings).toHaveLength(1);
    expect(verified.summary).toContain("No verified findings remained");
  });

  it("accepts quotes that span the previous line and current line window", () => {
    const file = buildLoadedReviewFile([
      {
        path: "src/demo.ts",
        startLine: 1,
        endLine: 4,
        totalLines: 4,
        content: [
          "const result = condition",
          "  ? doThing()",
          "  : doOtherThing();",
          "",
        ].join("\n"),
      },
    ]);

    const grounded = groundCodeReviewResponse({
      summary: "Found one branching issue.",
      overallVerdict: "issues_found",
      findings: [
        {
          severity: "low",
          certainty: "possible",
          file: "src/demo.ts",
          line: 2,
          title: "Branching logic may be hard to read",
          codeQuote: "const result = condition\n  ? doThing()",
          reasoning: "The expression spans multiple lines.",
        },
      ],
      followUp: [],
    }, file);

    expect(grounded.findings).toHaveLength(1);
    expect(grounded.rejectedFindings).toHaveLength(0);
  });

  it("discovers related repository files from relative imports and ts/js extension mapping", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-review-"));

    try {
      await fs.mkdir(path.join(tempRoot, "src", "tools"), { recursive: true });
      await fs.mkdir(path.join(tempRoot, "src", "utils"), { recursive: true });
      await fs.writeFile(path.join(tempRoot, "src", "tools", "WebSearchTool.ts"), [
        "import { decodeHexEntity } from \"../utils/html.js\";",
        "const { parseResult } = require(\"./parser\");",
        "#include \"./native.h\"",
        "",
      ].join("\n"), "utf8");
      await fs.writeFile(path.join(tempRoot, "src", "utils", "html.ts"), "export function decodeHexEntity() {}\n", "utf8");
      await fs.writeFile(path.join(tempRoot, "src", "tools", "parser.ts"), "export function parseResult() {}\n", "utf8");
      await fs.writeFile(path.join(tempRoot, "src", "tools", "native.h"), "#pragma once\n", "utf8");

      const related = await extractRelatedReviewFilePaths(tempRoot, buildLoadedReviewFile([
        {
          path: "src/tools/WebSearchTool.ts",
          startLine: 1,
          endLine: 4,
          totalLines: 4,
          content: [
            "import { decodeHexEntity } from \"../utils/html.js\";",
            "const { parseResult } = require(\"./parser\");",
            "#include \"./native.h\"",
            "",
          ].join("\n"),
        },
      ]), 5);

      expect(related).toEqual([
        "src/utils/html.ts",
        "src/tools/parser.ts",
        "src/tools/native.h",
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
