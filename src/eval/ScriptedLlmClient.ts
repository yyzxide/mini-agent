import type { AgentDecision } from "../agent/AgentDecision.js";
import type {
  LlmClient,
  LlmInput,
  TaskFrameCompletionInput,
  TaskFrameCompletionResult,
} from "../llm/LlmClient.js";

export class ScriptedLlmClient implements LlmClient {
  private readonly decisions: AgentDecision[];
  private readonly taskFrameCompletions: TaskFrameCompletionResult[];
  private readonly calls: LlmInput[] = [];
  private readonly taskFrameCalls: TaskFrameCompletionInput[] = [];

  constructor(
    decisions: AgentDecision[],
    taskFrameCompletions: TaskFrameCompletionResult[] = [],
  ) {
    this.decisions = decisions;
    this.taskFrameCompletions = taskFrameCompletions;
  }

  async chat(input: LlmInput): Promise<AgentDecision> {
    this.calls.push(input);
    return this.decisions[Math.min(input.state.step, this.decisions.length - 1)] ?? {
      type: "FAILED",
      error: "No scripted decision configured",
    };
  }

  async compileTaskFrame(
    input: TaskFrameCompletionInput,
  ): Promise<TaskFrameCompletionResult> {
    this.taskFrameCalls.push(input);
    const scriptedFrame = this.taskFrameCompletions[Math.min(
      this.taskFrameCalls.length - 1,
      this.taskFrameCompletions.length - 1,
    )];
    if (scriptedFrame) return scriptedFrame;
    const decision = this.decisions[Math.min(
      this.taskFrameCalls.length - 1,
      this.decisions.length - 1,
    )];
    if (decision?.type === "FINAL") {
      return { success: decision.success, text: decision.summary };
    }
    if (decision?.type === "FAILED") {
      return { success: false, error: decision.error };
    }
    return { success: false, error: "No scripted TaskFrame completion configured" };
  }

  getCallInputs(): LlmInput[] {
    return [...this.calls];
  }

  getTaskFrameCallInputs(): TaskFrameCompletionInput[] {
    return [...this.taskFrameCalls];
  }
}
