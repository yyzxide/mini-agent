import { describe, expect, it } from "vitest";
import {
  assessWebEvidence,
  buildInsufficientEvidenceAnswer,
  findUnsupportedWebAnswerUrls,
} from "../../src/cli/WebAnswerSupport.js";

describe("web evidence assessment", () => {
  it("marks two fetched independent sources as strong evidence", () => {
    const assessment = assessWebEvidence([
      source("https://one.example/report", "one"),
      source("https://two.example/report", "two"),
    ], true);
    expect(assessment).toMatchObject({ sufficient: true, level: "STRONG", fetchedSources: 2, independentDomains: 2 });
  });

  it("refuses definite live answers when evidence is insufficient", () => {
    const assessment = assessWebEvidence([{
      title: "snippet only",
      url: "https://one.example/report",
      snippet: "unverified snippet",
    }], true);
    const answer = buildInsufficientEvidenceAnswer({ question: "今天的价格是多少", assessment });
    expect(assessment.sufficient).toBe(false);
    expect(answer).toContain("证据不足");
    expect(answer).toContain("不对实时事实或具体数字作确定性结论");
  });

  it("requires two independent fetched domains for live facts", () => {
    expect(assessWebEvidence([
      source("https://one.example/report-a", "one"),
    ], true).sufficient).toBe(false);

    expect(assessWebEvidence([
      source("https://one.example/report-a", "one"),
      source("https://one.example/report-b", "two"),
    ], true).sufficient).toBe(false);
  });

  it("rejects answer URLs that were not gathered by web tools", () => {
    const sources = [source("https://one.example/report", "one")];
    const answer = [
      "已核验：[来源](https://one.example/report)。",
      "未核验：[伪造来源](https://fifa.example/invented-report)。",
    ].join("\n");

    expect(findUnsupportedWebAnswerUrls(answer, sources)).toEqual([
      "https://fifa.example/invented-report",
    ]);
  });
});

function source(url: string, text: string) {
  return {
    title: text,
    url,
    snippet: text,
    fetch: {
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      text: text.repeat(130),
      truncated: false,
      outputTruncated: false,
    },
  };
}
