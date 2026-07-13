import type { EventStore } from "../session/EventStore.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import type { SessionStore } from "../session/SessionStore.js";
import { resolveFollowUpQuestion } from "../web/WebQuestionPlanner.js";
import { appendLongTermMemoryContext, MemoryContextService } from "../memory/MemoryContextService.js";
import { planDirectAnswerMemory } from "../memory/DirectAnswerMemoryPolicy.js";
import { appendSkillContext, SkillContextService } from "../skills/SkillContextService.js";
import { buildConversationHistory } from "../session/ConversationHistory.js";
import {
  createOpenAICompatibleClient,
  openTaskSession,
  recordTaskUserMessage,
  recordLlmUsageFromClient,
} from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";
import { resolveLocalDirectReply, resolveLocalSessionReply } from "./DirectAnswerSupport.js";

export async function runDirectAnswerTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const { sessionId, sessionStore, eventStore } = await openTaskSession({ repoPath, userGoal, options });

  const recordsBeforeCurrent = await sessionStore.readRecords(sessionId).catch(() => []);
  const conversation = buildConversationHistory(recordsBeforeCurrent);
  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");
  const resolvedFollowUpGoal = resolveFollowUpQuestion(userGoal, sessionMemory);
  const memoryPlan = planDirectAnswerMemory({
    userGoal,
    ...(resolvedFollowUpGoal ? { resolvedFollowUpGoal } : {}),
    hasRecentConversation: conversation.length > 0,
  });
  const longTermMemory = memoryPlan.retrieve
    ? await new MemoryContextService({ repoPath }).build({
      query: memoryPlan.query,
      excludeSessionId: sessionId,
    }).catch(() => "(none)")
    : "(none)";
  const skillContext = await new SkillContextService({ repoPath }).build(resolvedFollowUpGoal ?? userGoal)
    .catch(() => "(none selected)");

  await recordTaskUserMessage({ sessionId, sessionStore, eventStore, content: userGoal });

  const recordsAfterUser = await sessionStore.readRecords(sessionId).catch(() => []);
  const localSessionReply = resolveLocalSessionReply(userGoal, recordsAfterUser);
  if (localSessionReply) {
    return await finalizeDirectAnswerSuccess(
      sessionStore,
      eventStore,
      sessionId,
      options,
      localSessionReply,
    );
  }

  const localReply = resolveLocalDirectReply(repoPath, userGoal);
  if (localReply) {
    return await finalizeDirectAnswerSuccess(
      sessionStore,
      eventStore,
      sessionId,
      options,
      localReply,
    );
  }

  const client = await createOpenAICompatibleClient(repoPath, options);
  const directContextBase = resolvedFollowUpGoal && resolvedFollowUpGoal !== userGoal
    ? `Resolved current request: ${resolvedFollowUpGoal}`
    : "";
  const directContext = appendSkillContext(
    appendLongTermMemoryContext(directContextBase, longTermMemory),
    skillContext,
  );
  const result = await client.completeText({
    userGoal,
    conversation,
    ...(directContext.trim().length > 0 ? { context: directContext.trim() } : {}),
    mode: "direct",
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "direct");

  if (!result.success || !result.text) {
    const error = result.error ?? "Direct answer failed";
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "DIRECT_ANSWER" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "DIRECT_ANSWER",
      summary: error,
      error,
    };
  }

  return await finalizeDirectAnswerSuccess(
    sessionStore,
    eventStore,
    sessionId,
    options,
    result.text,
  );
}

async function finalizeDirectAnswerSuccess(
  sessionStore: SessionStore,
  eventStore: EventStore,
  sessionId: string,
  options: AgentCliOptions,
  text: string,
): Promise<CliTaskResult> {
  process.stdout.write(`[answer]\n${text}\n`);

  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: text },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: text },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary: text,
      success: true,
      mode: "DIRECT_ANSWER",
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "DIRECT_ANSWER",
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "DIRECT_ANSWER",
    summary: text,
  };
}
