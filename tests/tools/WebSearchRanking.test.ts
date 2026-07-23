import { describe, expect, it } from "vitest";
import { rankWebSearchResults } from "../../src/tools/WebSearchRanking.js";

describe("WebSearchRanking", () => {
  it("promotes a newer first-party release beyond the provider's first five results", () => {
    const results = [
      {
        title: "Introducing GPT-5.5 - OpenAI",
        url: "https://openai.com/index/introducing-gpt-5-5/",
        snippet: "OpenAI April 23, 2026 product release.",
      },
      {
        title: "OpenAI Research releases",
        url: "https://openai.com/research/index/release/",
        snippet: "Research and product releases.",
      },
      {
        title: "OpenAI models 2026",
        url: "https://roundup.example/openai-models",
        snippet: "A third-party roundup from June 2026.",
      },
      {
        title: "Latest AI model releases",
        url: "https://tracker.example/latest",
        snippet: "Models from many vendors in July 2026.",
      },
      {
        title: "Complete model guide",
        url: "https://comparison.example/models",
        snippet: "An older comparison guide.",
      },
      {
        title: "GPT-5.6: Frontier intelligence that scales with your ambition",
        url: "https://openai.com/index/gpt-5-6/",
        snippet: "OpenAI July 9, 2026 product release.",
      },
    ];

    expect(rankWebSearchResults(results, "OpenAI latest model 2026")[0]).toMatchObject({
      url: "https://openai.com/index/gpt-5-6/",
    });
  });

  it("preserves provider order for non-temporal searches", () => {
    const results = [
      { title: "First", url: "https://example.com/first", snippet: "" },
      { title: "Second", url: "https://example.com/second", snippet: "" },
    ];

    expect(rankWebSearchResults(results, "example documentation")).toEqual(results);
  });
});
