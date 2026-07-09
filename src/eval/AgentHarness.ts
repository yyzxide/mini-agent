import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentDecision } from "../agent/AgentDecision.js";
import { AgentLoop } from "../agent/AgentLoop.js";
import type { AgentRunResult } from "../agent/AgentLoop.js";
import { CommandRunner } from "../command/CommandRunner.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { PatchManager } from "../patch/PatchManager.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { EventStore } from "../session/EventStore.js";
import { SessionStore } from "../session/SessionStore.js";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.js";
import { ScriptedLlmClient } from "./ScriptedLlmClient.js";

const execFileAsync = promisify(execFile);

export interface AgentHarnessScenario {
  name: string;
  userGoal: string;
  files?: Record<string, string>;
  decisions: AgentDecision[];
  maxSteps?: number;
  expected?: {
    success?: boolean;
    diffContains?: string[];
    filesContain?: Record<string, string>;
  };
}

export interface AgentHarnessResult {
  scenarioName: string;
  repoPath: string;
  run: AgentRunResult;
  llmCalls: number;
}

export class AgentHarness {
  async runScenario(scenario: AgentHarnessScenario): Promise<AgentHarnessResult> {
    const repoPath = await createScenarioRepo(scenario);
    const llmClient = new ScriptedLlmClient(scenario.decisions);
    const sessionStore = new SessionStore({ repoPath });
    const eventStore = new EventStore({ repoPath });
    const loop = new AgentLoop({
      repoPath,
      llmClient,
      toolRegistry: createDefaultToolRegistry(),
      sessionStore,
      eventStore,
      commandRunner: new CommandRunner({ repoPath }),
      permissionManager: new PermissionManager({ prompt: async () => "yes" }),
      patchManager: new PatchManager({ repoPath }),
      contextBuilder: new ContextBuilder({ repoPath }),
    });

    const run = await loop.run({
      userGoal: scenario.userGoal,
      autoApprove: true,
      nonInteractive: true,
      ...(scenario.maxSteps === undefined ? {} : { maxSteps: scenario.maxSteps }),
    });

    await assertScenarioExpectation(repoPath, run, scenario.expected);

    return {
      scenarioName: scenario.name,
      repoPath,
      run,
      llmCalls: llmClient.getCallInputs().length,
    };
  }
}

async function createScenarioRepo(scenario: AgentHarnessScenario): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-harness-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });

  for (const [relativePath, content] of Object.entries(scenario.files ?? {})) {
    const filePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  if (Object.keys(scenario.files ?? {}).length > 0) {
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
  }

  return repoPath;
}

async function assertScenarioExpectation(
  repoPath: string,
  run: AgentRunResult,
  expected: AgentHarnessScenario["expected"],
): Promise<void> {
  if (!expected) {
    return;
  }

  const failures: string[] = [];

  if (expected.success !== undefined && run.success !== expected.success) {
    failures.push(`Expected success=${String(expected.success)} but got ${String(run.success)}`);
  }

  for (const text of expected.diffContains ?? []) {
    if (!run.finalDiff.includes(text)) {
      failures.push(`Expected final diff to contain ${JSON.stringify(text)}`);
    }
  }

  for (const [relativePath, text] of Object.entries(expected.filesContain ?? {})) {
    const content = await fs.readFile(path.join(repoPath, relativePath), "utf8").catch(() => undefined);
    if (content === undefined) {
      failures.push(`Expected file to exist: ${relativePath}`);
    } else if (!content.includes(text)) {
      failures.push(`Expected ${relativePath} to contain ${JSON.stringify(text)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Agent harness scenario failed:\n${failures.join("\n")}`);
  }
}
