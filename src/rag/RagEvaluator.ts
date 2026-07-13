import type { RagEvalCase, RagEvalCaseResult, RagEvalResult } from "./RagTypes.js";
import type { RagStore } from "./RagStore.js";

export async function evaluateRag(store: RagStore, cases: RagEvalCase[]): Promise<RagEvalResult> {
  const results: RagEvalCaseResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    const response = await store.search(testCase.query, testCase.topK !== undefined ? { topK: testCase.topK } : {});
    const retrievedSources = [...new Set(response.results.map((result) => result.chunk.source))];
    const relevantSources = testCase.relevantSources ?? [];
    const ranks = relevantSources.map((source) => retrievedSources.findIndex((retrieved) => sourceMatches(retrieved, source)) + 1);
    const hits = ranks.filter((rank) => rank > 0).length;
    const recallAtK = relevantSources.length > 0 ? hits / relevantSources.length : 0;
    const firstRank = ranks.filter((rank) => rank > 0).sort((left, right) => left - right)[0];
    const reciprocalRank = firstRank ? 1 / firstRank : 0;
    const passed = testCase.expectNoAnswer === true ? !response.found : response.found && (relevantSources.length === 0 || hits > 0);
    results.push({
      id: testCase.id ?? `case-${index + 1}`,
      query: testCase.query,
      passed,
      found: response.found,
      retrievedSources,
      relevantSources,
      recallAtK,
      reciprocalRank,
    });
  }

  const answerable = results.filter((_, index) => cases[index]?.expectNoAnswer !== true);
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    answerabilityAccuracy: average(results.map((result, index) => result.found === (cases[index]?.expectNoAnswer !== true) ? 1 : 0)),
    hitRate: average(answerable.map((result) => result.reciprocalRank > 0 ? 1 : 0)),
    meanRecallAtK: average(answerable.map((result) => result.recallAtK)),
    meanReciprocalRank: average(answerable.map((result) => result.reciprocalRank)),
    cases: results,
  };
}

function sourceMatches(source: string, relevant: string): boolean {
  const normalized = relevant.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return source === normalized || source.startsWith(`${normalized}/`);
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
