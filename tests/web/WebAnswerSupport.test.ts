import { describe, expect, it } from "vitest";
import { assessWebEvidence, buildInsufficientEvidenceAnswer } from "../../src/cli/WebAnswerSupport.js";

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
