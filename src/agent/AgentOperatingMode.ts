import type { ToolSpec } from "../llm/LlmClient.js";

export type AgentOperatingMode = "EXECUTE" | "PLAN";

export function isPlanModeReadOnlyTool(tool: ToolSpec | undefined): boolean {
  return tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false;
}

export function selectToolsForOperatingMode(tools: ToolSpec[], mode: AgentOperatingMode): ToolSpec[] {
  return mode === "PLAN" ? tools.filter(isPlanModeReadOnlyTool) : tools;
}
