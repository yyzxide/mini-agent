import { AgentLoop } from "../agent/AgentLoop.js";
import type { AgentProgressEvent } from "../agent/AgentLoop.js";
import { resolveRepositoryFollowUpTask } from "../agent/TaskFollowUp.js";
import { CommandRunner } from "../command/CommandRunner.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createConfiguredToolRegistry } from "../mcp/McpRegistryLoader.js";
import { createOpenAICompatibleClient, createStores } from "./CliTaskRuntime.js";
import type { AgentCliOptions, CliTaskResult } from "./CliTaskRuntime.js";

export async function runAgentLoopTask(
  repoPath: string,
  userGoal: string,
  options: AgentCliOptions & { nonInteractive?: boolean },
  prompt?: (message: string) => Promise<string>,
): Promise<CliTaskResult> {
  const { sessionStore, eventStore } = createStores(repoPath, options.eventStream === true);
  const resolvedUserGoal = options.session
    ? await sessionStore.readRecords(options.session)
      .then((records) => resolveRepositoryFollowUpTask(userGoal, records)?.resolvedGoal)
      .catch(() => undefined)
    : undefined;
  const permissionManager = new PermissionManager(prompt ? { prompt } : {});
  const llmClient = await createOpenAICompatibleClient(repoPath, options);
  const { registry: toolRegistry, diagnostics } = await createConfiguredToolRegistry(repoPath);
  for (const diagnostic of diagnostics.filter((entry) => !entry.success)) {
    process.stderr.write(`[mcp] ${diagnostic.server}: ${diagnostic.error ?? "failed to load"}\n`);
  }
  const loop = new AgentLoop({
    repoPath,
    llmClient,
    toolRegistry,
    sessionStore,
    eventStore,
    commandRunner: new CommandRunner({ repoPath }),
    permissionManager,
    patchManager: new PatchManager({ repoPath }),
    contextBuilder: new ContextBuilder({ repoPath }),
    onProgress: writeAgentProgress,
    ...(prompt ? { askUser: prompt } : {}),
  });

  const result = await loop.run({
    userGoal: resolvedUserGoal ?? userGoal,
    ...(resolvedUserGoal ? { originalUserGoal: userGoal } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    autoApprove: true,
    nonInteractive: options.nonInteractive === true,
    keepSessionActive: options.keepSessionActive === true,
    operatingMode: options.operatingMode ?? "EXECUTE",
  }).finally(async () => await toolRegistry.dispose());

  return {
    success: result.success,
    sessionId: result.sessionId,
    mode: options.operatingMode === "PLAN" ? "PLAN" : "AGENT_LOOP",
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
  };
}


function writeAgentProgress(event: AgentProgressEvent): void {
  switch (event.type) {
    case "session":
      process.stdout.write(`[session] ${event.sessionId}\n`);
      break;
    case "plan":
      process.stdout.write(`[plan] ${event.message}\n`);
      break;
    case "tool":
      process.stdout.write(`[tool] ${event.toolName}\n`);
      break;
    case "patch":
      process.stdout.write(`[patch] ${event.description}\n`);
      break;
    case "command":
      process.stdout.write(`[command] ${event.command}\n`);
      break;
    case "ask_user":
      process.stdout.write(`[ask] ${event.message}\n`);
      break;
    case "diff":
      process.stdout.write("[diff] generated\n");
      break;
    case "summary":
      process.stdout.write(`[summary] ${event.summary}\n`);
      break;
    case "error":
      process.stdout.write(`[error] ${event.message}\n`);
      break;
  }
}

