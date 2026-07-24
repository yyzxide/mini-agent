import type { AgentDecision } from "../agent/AgentDecision.js";
import type {
  LlmClient,
  LlmInput,
  LlmTextCompletionInput,
  LlmTextCompletionResult,
} from "../llm/LlmClient.js";

export class ScriptedLlmClient implements LlmClient {
  private readonly decisions: AgentDecision[];
  private readonly calls: LlmInput[] = [];
  private readonly textCalls: LlmTextCompletionInput[] = [];

  constructor(decisions: AgentDecision[]) {
    this.decisions = decisions;
  }

  async chat(input: LlmInput): Promise<AgentDecision> {
    this.calls.push(input);
    return this.decisions[Math.min(input.state.step, this.decisions.length - 1)] ?? {
      type: "FAILED",
      error: "No scripted decision configured",
    };
  }

  async completeText(input: LlmTextCompletionInput): Promise<LlmTextCompletionResult> {
    this.textCalls.push(input);
    const decision = this.decisions[Math.min(this.textCalls.length - 1, this.decisions.length - 1)];
    if (decision?.type === "FINAL") {
      return { success: decision.success, text: decision.summary };
    }
    if (decision?.type === "FAILED") {
      return { success: false, error: decision.error };
    }
    return { success: false, error: "Scripted single-shot completion requires a FINAL or FAILED decision" };
  }

  getCallInputs(): LlmInput[] {
    return [...this.calls];
  }

  getTextCallInputs(): LlmTextCompletionInput[] {
    return [...this.textCalls];
  }
}
