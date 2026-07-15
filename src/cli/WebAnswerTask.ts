import { readSessionMemory } from "../session/SessionMemory.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext, ToolResult } from "../tools/Tool.js";
import { toJsonObject } from "../utils/json.js";
import { createRuntimeLogger } from "../utils/logger.js";
import { planWebQuestion, resolveFollowUpQuestion } from "../web/WebQuestionPlanner.js";
import { appendLongTermMemoryContext, MemoryContextService } from "../memory/MemoryContextService.js";
import { appendSkillContext, SkillContextService } from "../skills/SkillContextService.js";
import {
  createOpenAICompatibleClient,
  openTaskSession,
  recordTaskUserMessage,
  recordLlmUsageFromClient,
} from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";
import {
  buildLocalWebCapabilityCorrection,
  assessWebEvidence,
  buildInsufficientEvidenceAnswer,
  buildUnsupportedCitationAnswer,
  buildWebAnswerContext,
  buildWebAnswerRepairContext,
  containsInvalidWebCapabilityDenial,
  extractFetchedSource,
  extractWebSources,
  findUnsupportedWebAnswerUrls,
  isWebSearchData,
  mergeWebSources,
  rankWebSources,
  selectWebSourcesForFetching,
} from "./WebAnswerSupport.js";
import type { WebAnswerSource } from "./WebAnswerSupport.js";

export async function runWebAnswerTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const logger = createRuntimeLogger(repoPath);
  const { sessionId, sessionStore, eventStore } = await openTaskSession({
    repoPath,
    userGoal,
    options,
    mode: "WEB_ANSWER",
  });

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");
  const resolvedFollowUpGoal = resolveFollowUpQuestion(userGoal, sessionMemory);

  await recordTaskUserMessage({ sessionId, sessionStore, eventStore, content: userGoal });

  const client = await createOpenAICompatibleClient(repoPath, options);
  const webPlan = await planWebQuestion({
    userGoal: resolvedFollowUpGoal ?? userGoal,
    sessionMemory,
    client,
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "web_rewrite");
  const longTermMemory = webPlan.needsLiveData
    ? "(none)"
    : await new MemoryContextService({ repoPath }).build({
      query: webPlan.standaloneQuestion,
      sessionId,
    }).catch(() => "(none)");
  const answerMemory = appendLongTermMemoryContext(sessionMemory, longTermMemory);
  const skillContext = await new SkillContextService({ repoPath }).build(webPlan.standaloneQuestion)
    .catch(() => "(none selected)");
  const answerContext = appendSkillContext(answerMemory, skillContext);
  await logger.info("web", "Web plan prepared", {
    searchQueries: webPlan.searchQueries,
    sourceHints: webPlan.sourceHints,
    needsLiveData: webPlan.needsLiveData,
    plannerError: webPlan.plannerError ?? null,
  }, sessionId).catch(() => undefined);

  const registry = createDefaultToolRegistry();
  const toolContext: ToolContext = {
    repoPath,
    sessionId,
    sessionStore,
    eventStore,
    maxOutputChars: 12_000,
    autoApprove: true,
    nonInteractive: true,
  };

  const searchQueries = webPlan.searchQueries;
  const searchResults: Array<{ query: string; result: ToolResult<unknown> }> = [];
  let sources: WebAnswerSource[] = [];

  for (const query of searchQueries) {
    process.stdout.write("[tool] web_search\n");
    const result = await registry.execute("web_search", {
      query,
      maxResults: 6,
    }, toolContext);
    searchResults.push({ query, result });
    sources = mergeWebSources(sources, extractWebSources(result, query));
    await logger.info("web", "Web search attempt finished", {
      query,
      success: result.success,
      resultCount: extractWebSources(result, query).length,
      error: result.error?.message ?? null,
    }, sessionId).catch(() => undefined);

    if (sources.length >= 8) {
      break;
    }
  }

  sources = rankWebSources(sources, webPlan.sourceHints, searchQueries).slice(0, 8);

  const fetchCandidates = selectWebSourcesForFetching(sources, webPlan.needsLiveData ? 5 : 4);
  const targetFetchedSources = webPlan.needsLiveData ? 2 : 1;
  let successfulFetches = 0;
  const successfulFetchDomains = new Set<string>();

  for (const source of fetchCandidates) {
    process.stdout.write("[tool] fetch_url\n");
    const fetchResult = await registry.execute("fetch_url", {
      url: source.url,
      maxBytes: 120_000,
      extractText: true,
    }, {
      ...toolContext,
      maxOutputChars: 8_000,
    });
    const fetchedSource = extractFetchedSource(fetchResult);
    if (fetchedSource) {
      source.fetch = fetchedSource;
      successfulFetches += 1;
      const domain = readWebDomain(fetchedSource.finalUrl);
      if (domain) successfulFetchDomains.add(domain);
    } else if (fetchResult.error) {
      source.fetchError = fetchResult.error.message;
    }

    await logger.info("web", "Source fetch finished", {
      url: source.url,
      success: Boolean(fetchedSource),
      error: fetchResult.error?.message ?? null,
    }, sessionId).catch(() => undefined);

    const reachedFetchTarget = successfulFetches >= targetFetchedSources;
    const reachedDomainTarget = !webPlan.needsLiveData || successfulFetchDomains.size >= 2;
    if (reachedFetchTarget && reachedDomainTarget) {
      break;
    }
  }

  const evidence = assessWebEvidence(sources, webPlan.needsLiveData);
  const webAnswerContext = buildWebAnswerContext({
    userGoal,
    webPlan,
    sessionMemory: answerContext,
    searchQueries,
    searchResults,
    sources,
  });
  const result = evidence.sufficient
    ? await client.completeText({
      userGoal: webPlan.standaloneQuestion,
      context: webAnswerContext,
      mode: "web",
    })
    : { success: true, text: buildInsufficientEvidenceAnswer({ question: webPlan.standaloneQuestion, assessment: evidence }) };
  if (evidence.sufficient) await recordLlmUsageFromClient(sessionStore, sessionId, client, "web");

  if (!result.success || !result.text) {
    const error = result.error ?? "Web answer failed";
    await logger.error("web", "Web answer generation failed", {
      searchQueryCount: searchQueries.length,
      sourceCount: sources.length,
      fetchedSourceCount: successfulFetches,
      error,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "WEB_ANSWER" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "WEB_ANSWER",
      summary: error,
      error,
    };
  }

  let answerText = result.text;
  const capabilityDenial = containsInvalidWebCapabilityDenial(answerText);
  const unsupportedUrls = findUnsupportedWebAnswerUrls(answerText, sources);
  if (capabilityDenial || unsupportedUrls.length > 0) {
    await logger.warn("web", "Web answer failed local validation; requesting repair", {
      searchQueryCount: searchQueries.length,
      sourceCount: sources.length,
      fetchedSourceCount: successfulFetches,
      capabilityDenial,
      unsupportedUrls,
      answerPreview: answerText.slice(0, 500),
    }, sessionId).catch(() => undefined);

    const repaired = await client.completeText({
      userGoal: webPlan.standaloneQuestion,
      context: buildWebAnswerRepairContext({
        originalContext: webAnswerContext,
        invalidAnswer: answerText,
        ...(unsupportedUrls.length > 0 ? { unsupportedUrls } : {}),
      }),
      mode: "web",
    });
    await recordLlmUsageFromClient(sessionStore, sessionId, client, "web_repair");

    const repairedText = repaired.success ? repaired.text : undefined;
    const repairedUnsupportedUrls = repairedText ? findUnsupportedWebAnswerUrls(repairedText, sources) : [];
    if (repairedText && !containsInvalidWebCapabilityDenial(repairedText) && repairedUnsupportedUrls.length === 0) {
      answerText = repairedText;
    } else if (unsupportedUrls.length > 0 || repairedUnsupportedUrls.length > 0) {
      answerText = buildUnsupportedCitationAnswer(sources);
    } else {
      answerText = buildLocalWebCapabilityCorrection({
        searchQueryCount: searchQueries.length,
        sourceCount: sources.length,
        fetchedSourceCount: successfulFetches,
        sources,
      });
    }
  }

  process.stdout.write(`[answer]\n${answerText}\n`);
  await logger.info("web", "Web answer generated", {
    searchQueryCount: searchQueries.length,
    sourceCount: sources.length,
    fetchedSourceCount: successfulFetches,
  }, sessionId).catch(() => undefined);

  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: answerText },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: answerText },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary: answerText,
      success: true,
      mode: "WEB_ANSWER",
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "WEB_ANSWER",
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "WEB_ANSWER",
    summary: answerText,
    metadata: toJsonObject({
      searchQueryCount: searchQueries.length,
      sourceCount: sources.length,
      fetchedSourceCount: successfulFetches,
      fetchedSources: sources.filter((source) => source.fetch).map((source) => source.url),
      searchProviders: searchResults
        .map((entry) => isWebSearchData(entry.result.data) ? entry.result.data.provider : null)
        .filter((provider): provider is string => typeof provider === "string"),
    }),
  };
}

function readWebDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
