import type { AgentDecision } from "../agent/AgentDecision.js";
import type { LlmClient, LlmInput } from "../llm/LlmClient.js";

export class ScriptedLlmClient implements LlmClient {
  private readonly decisions: AgentDecision[];
  private readonly calls: LlmInput[] = [];

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

  getCallInputs(): LlmInput[] {
    return [...this.calls];
  }
}
