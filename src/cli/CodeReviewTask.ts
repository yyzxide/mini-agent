import { applyReviewVerification, extractLikelyReviewFilePath, groundCodeReviewResponse } from "../review/CodeReview.js";
import { readSessionMemory } from "../session/SessionMemory.js";
import { toJsonObject } from "../utils/json.js";
import { createRuntimeLogger } from "../utils/logger.js";
import { appendLongTermMemoryContext, MemoryContextService } from "../memory/MemoryContextService.js";
import { planMemoryRead } from "../memory/MemoryPolicy.js";
import { appendSkillContext, SkillContextService } from "../skills/SkillContextService.js";
import {
  buildCodeReviewContext,
  buildCodeReviewVerificationContext,
  loadReviewFile,
  loadSupplementalReviewFiles,
  renderCodeReviewOutput,
} from "./CodeReviewSupport.js";
import {
  createOpenAICompatibleClient,
  openTaskSession,
  recordTaskUserMessage,
  recordLlmUsageFromClient,
} from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";

export async function runCodeReviewTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions,
): Promise<CliTaskResult> {
  const logger = createRuntimeLogger(repoPath);
  const { sessionId, sessionStore, eventStore } = await openTaskSession({
    repoPath,
    userGoal,
    options,
    mode: "CODE_REVIEW",
  });

  const sessionMemory = await readSessionMemory(sessionStore, sessionId, { maxRecords: 80, maxChars: 16_000 })
    .catch(() => "(none)");
  const memoryPlan = planMemoryRead({ query: userGoal, mode: "CODE_REVIEW" });
  const longTermMemory = memoryPlan.retrieve
    ? await new MemoryContextService({ repoPath }).build({
      query: memoryPlan.query,
      ...(memoryPlan.excludeActiveSession ? { excludeSessionId: sessionId } : {}),
      allowedKinds: memoryPlan.allowedKinds,
      allowedScopes: memoryPlan.allowedScopes,
    }).catch(() => "(none)")
    : "(none)";
  const reviewMemory = appendLongTermMemoryContext(sessionMemory, longTermMemory);
  const skillContext = await new SkillContextService({ repoPath }).build(userGoal).catch(() => "(none selected)");
  const reviewContext = appendSkillContext(reviewMemory, skillContext);

  await recordTaskUserMessage({ sessionId, sessionStore, eventStore, content: userGoal });

  const reviewTargetPath = extractLikelyReviewFilePath(userGoal);
  if (!reviewTargetPath) {
    const message = "Please provide a repository file path to review, for example src/tools/WebSearchTool.ts.";
    await logger.warn("review", "Review target path missing", {
      task: userGoal,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[ask] ${message}\n`);
    process.stdout.write(`${message}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: message },
    });
    await eventStore.appendEvent(sessionId, {
      type: "ASSISTANT_MESSAGE",
      payload: { content: message },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "CODE_REVIEW",
      summary: message,
      error: message,
    };
  }

  await logger.info("review", "Review target resolved", {
    reviewTargetPath,
  }, sessionId).catch(() => undefined);

  const loadedFile = await loadReviewFile(repoPath, reviewTargetPath, {
    sessionId,
    sessionStore,
    eventStore,
  });
  if (!loadedFile.success) {
    const error = loadedFile.error ?? "Failed to load review target";
    await logger.error("review", "Review target load failed", {
      reviewTargetPath,
      error,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "CODE_REVIEW" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "CODE_REVIEW",
      summary: error,
      error,
    };
  }

  await logger.info("review", "Review file loaded", {
    file: loadedFile.file.path,
    includedEndLine: loadedFile.file.includedEndLine,
    totalLines: loadedFile.file.totalLines,
    truncated: loadedFile.file.truncated,
  }, sessionId).catch(() => undefined);

  const supplementalFiles = await loadSupplementalReviewFiles(repoPath, loadedFile.file, {
    sessionId,
    sessionStore,
    eventStore,
  });

  await logger.info("review", "Review supplemental files loaded", {
    file: loadedFile.file.path,
    supplementalFileCount: supplementalFiles.length,
    supplementalFiles: supplementalFiles.map((file) => file.path),
  }, sessionId).catch(() => undefined);

  const client = await createOpenAICompatibleClient(repoPath, options);
  const reviewResult = await client.completeReview({
    userGoal,
    context: buildCodeReviewContext({
      userGoal,
      sessionMemory: reviewContext,
      reviewFile: loadedFile.file,
      supplementalFiles,
    }),
  });
  await recordLlmUsageFromClient(sessionStore, sessionId, client, "review_json");

  if (!reviewResult.success || !reviewResult.review) {
    const error = reviewResult.error ?? "Code review failed";
    await logger.error("review", "Review draft generation failed", {
      file: loadedFile.file.path,
      error,
    }, sessionId).catch(() => undefined);
    process.stdout.write(`[error] ${error}\n`);
    await sessionStore.appendRecord(sessionId, {
      type: "ERROR",
      payload: { message: error },
    });
    await eventStore.appendEvent(sessionId, {
      type: "TASK_FAILED",
      payload: { error, mode: "CODE_REVIEW" },
    });
    if (options.keepSessionActive !== true) {
      await sessionStore.updateSessionStatus(sessionId, "FAILED");
    }
    return {
      success: false,
      sessionId,
      mode: "CODE_REVIEW",
      summary: error,
      error,
    };
  }

  let groundedReview = groundCodeReviewResponse(reviewResult.review, loadedFile.file);
  await logger.info("review", "Review draft grounded", {
    file: loadedFile.file.path,
    groundedFindings: groundedReview.findings.length,
    rejectedByGrounding: groundedReview.rejectedFindings.length,
    overallVerdict: groundedReview.overallVerdict,
  }, sessionId).catch(() => undefined);

  let verificationApplied = false;
  if (groundedReview.findings.length > 0) {
    const verificationResult = await client.verifyReview({
      userGoal,
      context: buildCodeReviewVerificationContext({
        userGoal,
        reviewFile: loadedFile.file,
        supplementalFiles,
        findings: groundedReview.findings,
      }),
    });
    await recordLlmUsageFromClient(sessionStore, sessionId, client, "review_verify_json");

    if (verificationResult.success && verificationResult.verification) {
      verificationApplied = true;
      const findingsBeforeVerification = groundedReview.findings.length;
      groundedReview = applyReviewVerification(groundedReview, verificationResult.verification);
      await logger.info("review", "Review verification applied", {
        file: loadedFile.file.path,
        findingsBeforeVerification,
        finalFindings: groundedReview.findings.length,
        rejectedTotal: groundedReview.rejectedFindings.length,
      }, sessionId).catch(() => undefined);
    } else {
      await logger.warn("review", "Review verification failed", {
        file: loadedFile.file.path,
        error: verificationResult.error ?? null,
      }, sessionId).catch(() => undefined);
    }
  } else {
    await logger.info("review", "Review verification skipped because no grounded findings remained", {
      file: loadedFile.file.path,
    }, sessionId).catch(() => undefined);
  }

  const renderedReview = renderCodeReviewOutput(groundedReview, loadedFile.file, supplementalFiles);
  process.stdout.write(`${renderedReview}\n`);

  await logger.info("review", "Review task finished", {
    file: loadedFile.file.path,
    findings: groundedReview.findings.length,
    rejectedFindings: groundedReview.rejectedFindings.length,
    overallVerdict: groundedReview.overallVerdict,
  }, sessionId).catch(() => undefined);

  const summary = groundedReview.summary;
  await sessionStore.appendRecord(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: renderedReview },
  });
  await eventStore.appendEvent(sessionId, {
    type: "ASSISTANT_MESSAGE",
    payload: { content: renderedReview },
  });
  await sessionStore.appendRecord(sessionId, {
    type: "TASK_SUMMARY",
    payload: {
      summary,
      success: true,
      mode: "CODE_REVIEW",
      file: loadedFile.file.path,
      findings: groundedReview.findings.length,
      rejectedFindings: groundedReview.rejectedFindings.length,
      overallVerdict: groundedReview.overallVerdict,
    },
  });
  await eventStore.appendEvent(sessionId, {
    type: "TASK_FINISHED",
    payload: {
      success: true,
      mode: "CODE_REVIEW",
      file: loadedFile.file.path,
      findings: groundedReview.findings.length,
      rejectedFindings: groundedReview.rejectedFindings.length,
      overallVerdict: groundedReview.overallVerdict,
    },
  });
  if (options.keepSessionActive !== true) {
    await sessionStore.updateSessionStatus(sessionId, "FINISHED");
  }

  return {
    success: true,
    sessionId,
    mode: "CODE_REVIEW",
    summary,
    metadata: toJsonObject({
      reviewFile: loadedFile.file.path,
      includedEndLine: loadedFile.file.includedEndLine,
      totalLines: loadedFile.file.totalLines,
      truncated: loadedFile.file.truncated,
      supplementalFileCount: supplementalFiles.length,
      supplementalFiles: supplementalFiles.map((file) => file.path),
      findings: groundedReview.findings.length,
      rejectedFindings: groundedReview.rejectedFindings.length,
      overallVerdict: groundedReview.overallVerdict,
      verificationApplied,
    }),
  };
}
