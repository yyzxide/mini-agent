import type { AgentTaskContract } from "../agent/AgentTaskContract.js";
import type { ContextTrace } from "../context/ContextTypes.js";
import type { JsonObject, JsonValue } from "../session/SessionTypes.js";
import { redactSecrets } from "../utils/logger.js";
import { sanitizeTerminalText } from "./TerminalSanitizer.js";
import type {
  AgentRuntimeEvent,
  RuntimeLlmUsage,
  RuntimeVerbosity,
} from "./AgentRuntimeEvent.js";

export interface TerminalRendererOptions {
  contract: AgentTaskContract;
  verbosity?: RuntimeVerbosity;
  write?: (text: string) => void;
  color?: boolean;
}

export class TerminalRenderer {
  private contract: AgentTaskContract;
  private readonly verbosity: RuntimeVerbosity;
  private readonly write: (text: string) => void;
  private readonly color: boolean;
  private commandOutputChars = 0;
  private commandOutputTruncated = false;
  private llmCalls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private reasoningTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private hasUsage = false;
  private hasCacheReadTelemetry = false;
  private hasCacheWriteTelemetry = false;

  constructor(options: TerminalRendererOptions) {
    this.contract = options.contract;
    this.verbosity = options.verbosity ?? "normal";
    this.write = options.write ?? ((text) => process.stdout.write(text));
    this.color = options.color ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
  }

  render(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case "session":
        this.line(`${this.paint("cyan", "●")} [session] ${sanitizeTerminalText(event.sessionId)}`);
        return;
      case "follow_up":
        this.line(`${this.paint("blue", "├─")} [follow-up] artifact ${event.intent.toLowerCase()} · source=${event.source}`);
        this.detail(`${event.files.join(", ")}${event.llmSkipped ? " · LLM skipped" : ""}`);
        return;
      case "conversation":
        this.renderConversation(event.trace);
        return;
      case "understanding":
        if (event.source !== "DETERMINISTIC" || this.verbosity !== "normal") {
          this.line(`${this.paint("cyan", "├─")} [understanding] ${event.source.toLowerCase()} · ${event.operation}/${event.target} · confidence=${event.confidence.toFixed(2)}`);
          if (this.verbosity !== "normal") this.detail(event.reason);
        }
        return;
      case "task_contract":
        this.contract = {
          ...this.contract,
          kind: event.kind as AgentTaskContract["kind"],
          outputKind: event.outputKind as AgentTaskContract["outputKind"],
        };
        return;
      case "decision":
        if (!["PLAN", "FINAL", "FAILED"].includes(event.decisionType)) {
          this.line(`${this.paint("cyan", "├─")} [decision:${event.decisionType}] ${singleLine(event.message, 240)}`);
        }
        if (this.verbosity === "trace" && event.decision) this.detail(`payload=${safeJson(event.decision)}`);
        return;
      case "plan":
        this.line(`${this.paint("cyan", "◆")} [plan] ${sanitizeTerminalText(event.message)}`);
        return;
      case "context":
        this.renderContext(event.trace, event.step);
        return;
      case "llm":
        this.renderLlm(event);
        return;
      case "tool":
        this.line(`${this.paint("blue", "├─")} [tool] ${event.toolName}${formatToolHeadline(event.input)}`);
        if (this.verbosity !== "normal") this.detail(`input=${safeJson(event.input)}`);
        return;
      case "tool_result":
        this.line(`${this.paint(event.success ? "green" : "red", "│  └─")} ${event.success ? "✓" : "✗"} ${event.toolName} ${formatDuration(event.durationMs)}${event.summary ? ` · ${singleLine(event.summary, 180)}` : ""}`);
        if (this.verbosity === "trace" && event.resultPreview) this.detail(`result=${event.resultPreview}`);
        if (!event.success && event.error) this.detail(event.error);
        return;
      case "agents":
        this.line(`${this.paint(event.phase === "failed" ? "red" : "magenta", "├─")} [agents] ${event.phase}: ${sanitizeTerminalText(event.message)}`);
        for (const task of event.taskDetails ?? []) {
          const dependency = task.dependsOn.length > 0 ? ` · after=${task.dependsOn.join(",")}` : "";
          const status = task.status ? ` · ${task.status.toLowerCase()}` : "";
          const files = task.changedFiles?.length ? ` · files=${task.changedFiles.join(",")}` : "";
          this.detail(`${task.taskId} · ${task.role} · ${task.access}${dependency}${status}${files}`);
          if (task.error) this.detail(`error=${task.error}`);
        }
        return;
      case "agent_task": {
        const marker = event.phase === "task_finished"
          || event.phase === "tool_finished"
          || event.phase === "command_finished"
          ? event.success === false || (event.status !== undefined && event.status !== "COMPLETED") ? "✗" : "✓"
          : "├─";
        const label = event.phase === "thinking"
          ? `thinking${event.step === undefined ? "" : ` step=${String(event.step)}`}`
          : event.phase === "decision"
            ? `decision${event.decisionType ? `:${event.decisionType}` : ""}`
            : event.phase.replace("_", " ");
        this.line(`${this.paint(marker === "✗" ? "red" : "magenta", marker)} [agent:${event.taskId}] ${label} · ${event.role} · ${event.access}${event.toolName ? ` · ${event.toolName}` : ""}`);
        if (event.message && event.phase !== "command_output") this.detail(singleLine(event.message, 240));
        if (event.workspaceKind) {
          this.detail(`workspace=${event.workspaceKind.toLowerCase()} · baseline=${event.baselineFingerprint?.slice(0, 12) ?? "unknown"}`);
        }
        if (event.command) {
          this.detail(`command=${singleLine(event.command, 180)}${event.exitCode === undefined ? "" : ` · exit=${String(event.exitCode)}`}`);
        }
        if (event.phase === "command_output" && event.message) {
          this.detail(`${event.stream ?? "stdout"}: ${singleLine(event.message, 240)}`);
        }
        if (event.phase === "patch_applied" && event.changedFiles?.length) {
          this.detail(`isolated files=${event.changedFiles.join(",")}`);
        }
        if (event.dependsOn?.length) this.detail(`depends on ${event.dependsOn.join(", ")}`);
        if (event.status) this.detail(`status=${event.status}${event.changedFiles?.length ? ` · files=${event.changedFiles.join(",")}` : ""}`);
        if (event.toolsCalled?.length) this.detail(`tools=${event.toolsCalled.join(", ")}`);
        if (event.error) this.detail(`error=${event.error}`);
        if (event.action) this.detail(`recovery=${event.action}`);
        return;
      }
      case "patch":
        this.line(`${this.paint("yellow", "├─")} [patch] ${sanitizeTerminalText(event.description)}`);
        return;
      case "patch_result":
        this.line(`${this.paint(event.success ? "green" : "red", "│  └─")} ${event.success ? "✓" : "✗"} patch ${formatDuration(event.durationMs)}${event.error ? ` · ${singleLine(event.error, 180)}` : ""}`);
        return;
      case "command":
        this.commandOutputChars = 0;
        this.commandOutputTruncated = false;
        this.line(`${this.paint("yellow", "├─")} [command] ${sanitizeTerminalText(event.command)}`);
        if (this.verbosity !== "normal" && event.cwd) this.detail(`cwd=${event.cwd}`);
        return;
      case "command_output":
        this.renderCommandOutput(event.stream, event.chunk);
        return;
      case "command_result":
        this.line(`${this.paint(event.success ? "green" : "red", "│  └─")} ${event.success ? "✓" : "✗"} exit=${event.exitCode ?? "none"} · ${formatDuration(event.durationMs)}${event.timedOut ? " · timeout" : ""}${event.truncated ? " · captured output truncated" : ""}`);
        return;
      case "cache": {
        const reads = event.memoryHits + event.diskHits;
        const total = reads + event.misses;
        const rate = total > 0 ? ` · hit ${formatPercent(reads / total)}` : "";
        this.line(`${this.paint("magenta", "├─")} [cache:embedding] memory=${event.memoryHits} disk=${event.diskHits} miss=${event.misses} write=${event.writes} coalesced=${event.coalescedRequests}${rate}`);
        return;
      }
      case "guardrail":
        this.line(`${this.paint("yellow", "│  └─")} [guardrail:${sanitizeTerminalText(event.code)}] ${sanitizeTerminalText(event.message)}`);
        return;
      case "ask_user":
        this.line(`${this.paint("yellow", "◆")} [ask] ${sanitizeTerminalText(event.message)}`);
        return;
      case "diff":
        return;
      case "summary":
        this.renderSummary(event.summary, event.success);
        return;
      case "error":
        this.line(`${this.paint("red", "✗")} [error] ${sanitizeTerminalText(event.message)}`);
        return;
    }
  }

  private renderConversation(trace: Extract<AgentRuntimeEvent, { type: "conversation" }>["trace"]): void {
    const messages = trace.selectedMessages === trace.totalMessages
      ? `${String(trace.selectedMessages)} messages`
      : `${String(trace.selectedMessages)}/${String(trace.totalMessages)} messages`;
    const qualifiers = trace.totalMessages === 0
      ? ["new session"]
      : [
        trace.selectionStrategy === "LATEST_REFERENT" ? "prioritized latest exchange" : undefined,
        trace.selectionStrategy === "PRIOR_RESPONSE_AUDIT" ? "prior-response audit" : undefined,
        trace.selectionStrategy === "PRIOR_RESPONSE_AUDIT" && trace.matchedAssistantMessages > 0
          ? `matched ${String(trace.matchedAssistantMessages)} prior assistant message(s)`
          : undefined,
        trace.truncated ? "history limited" : undefined,
      ].filter((value): value is string => value !== undefined);
    const qualifier = qualifiers.length > 0 ? ` · ${qualifiers.join(" · ")}` : "";
    this.line(`${this.paint("blue", "├─")} [conversation] ${messages} · ~${formatTokens(trace.estimatedOutputTokens)} tokens${qualifier}`);

    if (this.verbosity !== "normal" && trace.estimatedInputTokens !== trace.estimatedOutputTokens) {
      this.detail(`available ~${formatTokens(trace.estimatedInputTokens)} tokens → selected ~${formatTokens(trace.estimatedOutputTokens)}`);
    }
    if (this.verbosity === "trace" && trace.roles.length > 0) {
      this.detail(`roles=${trace.roles.join(",")}`);
    }
  }

  private renderContext(trace: ContextTrace, step?: number): void {
    const sourceTokens = trace.sections
      .filter((section) => section.selected || /skipped because|could not fit/i.test(section.reason))
      .reduce((total, section) => total + section.estimatedTokens, 0);
    const includedTokens = trace.totalEstimatedTokens;
    const savedTokens = Math.max(0, sourceTokens - includedTokens);
    const ratio = sourceTokens > 0 ? savedTokens / sourceTokens : 0;
    const truncated = trace.sections.filter((section) => section.truncated);
    const skipped = trace.sections.filter((section) => !section.selected && /skipped because|could not fit/i.test(section.reason));
    this.line(`${this.paint("blue", "├─")} [context]${step === undefined ? "" : ` step=${String(step + 1)}`} · selected=${formatTokens(includedTokens)}/${formatTokens(trace.maxTokens)} tokens${savedTokens > 0 ? ` · compacted ${formatTokens(savedTokens)} (${formatPercent(ratio)})` : ""}`);

    const sessionMemorySection = trace.sections.find((section) => section.id === "conversation_memory");
    if (trace.sessionMemory) {
      const recordCount = trace.sessionMemory.selectedRecords === trace.sessionMemory.totalRecords
        ? `${String(trace.sessionMemory.selectedRecords)} records`
        : `${String(trace.sessionMemory.selectedRecords)}/${String(trace.sessionMemory.totalRecords)} records`;
      const selection = sessionMemorySection?.selected
        ? `selected ~${formatTokens(sessionMemorySection.includedTokens)} tokens`
        : "excluded";
      const compaction = trace.sessionMemory.compacted
        ? ` · compacted from ~${formatTokens(trace.sessionMemory.estimatedInputTokens)} tokens`
        : "";
      this.detail(`[memory:session] ${recordCount} · ${selection}${compaction}`);
      if (this.verbosity !== "normal" && (trace.sessionMemory.excludedCurrentRunRecords ?? 0) > 0) {
        this.detail(`[memory:session] excluded ${String(trace.sessionMemory.excludedCurrentRunRecords)} current-run records; live evidence comes from AgentState`);
      }
      if (this.verbosity !== "normal" && trace.sessionMemory.strategy === "structured-salience-v2") {
        this.detail(`[memory:session] strategy=structured-salience-v2 · pinned=${String(trace.sessionMemory.pinnedRecords ?? 0)} · clipped=${String(trace.sessionMemory.clippedRecords ?? 0)} · dropped=${String(trace.sessionMemory.droppedRecords ?? 0)}`);
      }
      if (this.verbosity === "trace" && trace.sessionMemory.selections && trace.sessionMemory.selections.length > 0) {
        this.detail(`[memory:session] sources=${trace.sessionMemory.selections.map((item) => `${item.sourceId}:${item.bucket.toLowerCase()}${item.clipped ? ":clipped" : ""} (${item.reason})`).join(",")}`);
      }
    }
    const longTermMemorySection = trace.sections.find((section) => section.id === "long_term_memory");
    if (longTermMemorySection?.selected) {
      this.detail(`[memory:long-term] selected ~${formatTokens(longTermMemorySection.includedTokens)} tokens`);
    } else if (this.verbosity !== "normal" && longTermMemorySection) {
      this.detail("[memory:long-term] excluded or not requested");
    }
    if (this.verbosity !== "normal") {
      if (truncated.length > 0) this.detail(`truncated=${truncated.map((section) => section.id).join(",")}`);
      if (skipped.length > 0) this.detail(`skipped=${skipped.map((section) => section.id).join(",")}`);
    }
    if (this.verbosity === "trace") {
      for (const section of trace.sections) {
        this.detail(`${section.selected ? "include" : "exclude"} ${section.id}: ${formatTokens(section.includedTokens)}/${formatTokens(section.estimatedTokens)}${section.truncated ? " truncated" : ""}`);
      }
    }

  }

  private renderLlm(event: Extract<AgentRuntimeEvent, { type: "llm" }>): void {
    if (event.phase === "started") {
      this.line(`${this.paint("magenta", "├─")} [thinking]${event.step === undefined ? "" : ` step=${String(event.step + 1)}`} · model decision${event.model ? ` · ${event.model}` : ""}`);
      return;
    }
    if (event.phase === "failed") {
      this.line(`${this.paint("red", "│  └─")} ✗ model call failed${event.durationMs === undefined ? "" : ` · ${formatDuration(event.durationMs)}`}${event.error ? ` · ${singleLine(event.error, 180)}` : ""}`);
      return;
    }

    const usage = event.usage;
    if (usage) this.accumulateUsage(usage, event.calls ?? 1);
    const details = usage?.usageAvailable
      ? formatLlmUsage(usage)
      : "token usage unavailable";
    this.line(`${this.paint("magenta", "│  └─")} ✓ [llm] ${details}${event.durationMs === undefined ? "" : ` · ${formatDuration(event.durationMs)}`}`);
    if ((usage?.reasoningTokens ?? 0) > 0 && this.verbosity !== "normal") {
      const availability = usage?.reasoningContentAvailable
        ? " · private reasoning field available"
        : "";
      const policy = this.verbosity === "trace"
        ? "; raw chain-of-thought is not displayed—structured [decision] lines are the auditable action rationale"
        : "";
      this.detail(`[reasoning] ${formatTokens(usage?.reasoningTokens)} token(s) reported${availability}${policy}`);
    }
    if (this.verbosity === "trace") {
      this.detail(`mode=${event.mode}${event.finishReason ? ` finish=${event.finishReason}` : ""}${event.calls ? ` calls=${event.calls}` : ""}`);
    }
  }

  private renderCommandOutput(stream: "stdout" | "stderr", chunk: string): void {
    const limit = this.verbosity === "trace" ? 30_000 : this.verbosity === "verbose" ? 16_000 : 4_000;
    if (this.commandOutputChars >= limit) {
      if (!this.commandOutputTruncated) {
        this.commandOutputTruncated = true;
        this.detail("live command output truncated; full bounded result remains in the session record");
      }
      return;
    }
    const remaining = limit - this.commandOutputChars;
    const visible = sanitizeTerminalText(chunk).slice(0, remaining);
    this.commandOutputChars += visible.length;
    const prefix = stream === "stderr" ? this.paint("red", "│  ! ") : this.paint("dim", "│    ");
    for (const line of visible.replace(/\r/g, "").split("\n")) {
      if (line.length > 0) this.line(`${prefix}${line}`);
    }
  }

  private renderSummary(summary: string, success: boolean): void {
    const safeSummary = sanitizeTerminalText(summary);
    if (this.hasUsage) {
      const cacheRatio = this.promptTokens > 0 ? this.cacheReadTokens / this.promptTokens : 0;
      const cacheRead = this.hasCacheReadTelemetry
        ? `${formatTokens(this.cacheReadTokens)} (${formatPercent(cacheRatio)})`
        : "unreported";
      this.line(`${this.paint("magenta", "◆")} [usage] calls=${this.llmCalls} · in=${formatTokens(this.promptTokens)} · prompt-cache-read=${cacheRead} · out=${formatTokens(this.completionTokens)} · reasoning=${formatTokens(this.reasoningTokens)}${this.hasCacheWriteTelemetry ? ` · prompt-cache-write=${formatTokens(this.cacheWriteTokens)}` : " · prompt-cache-write=unreported"}`);
    }
    if (this.contract.outputKind === "CODE_REVIEW") {
      this.line(`[review]\n${safeSummary}`);
    } else if (this.contract.kind === "DIRECT_RESPONSE" || this.contract.kind === "WEB_RESEARCH") {
      this.line(`[answer]\n${safeSummary}`);
    } else {
      this.line(`[summary] ${safeSummary}`);
    }
    if (!success && this.verbosity !== "normal") this.detail("task completed with success=false");
  }

  private accumulateUsage(usage: RuntimeLlmUsage, calls: number): void {
    if (!usage.usageAvailable) return;
    this.hasUsage = true;
    this.llmCalls += calls;
    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    if (usage.cacheReadTokens !== undefined) {
      this.hasCacheReadTelemetry = true;
      this.cacheReadTokens += usage.cacheReadTokens;
    }
    if (usage.cacheWriteTokens !== undefined) {
      this.hasCacheWriteTelemetry = true;
      this.cacheWriteTokens += usage.cacheWriteTokens;
    }
  }

  private detail(text: string): void {
    this.line(`${this.paint("dim", "│  └─")} ${sanitizeTerminalText(text)}`);
  }

  private line(text: string): void {
    this.write(`${text}\n`);
  }

  private paint(color: "cyan" | "blue" | "green" | "yellow" | "red" | "magenta" | "dim", text: string): string {
    if (!this.color) return text;
    const code = { cyan: 36, blue: 34, green: 32, yellow: 33, red: 31, magenta: 35, dim: 2 }[color];
    return `\u001B[${String(code)}m${text}\u001B[0m`;
  }
}

function formatLlmUsage(usage: RuntimeLlmUsage): string {
  const parts = [
    `in=${formatTokens(usage.promptTokens)}`,
    `prompt-cache-read=${usage.cacheReadTokens === undefined ? "unreported" : formatTokens(usage.cacheReadTokens)}`,
    `out=${formatTokens(usage.completionTokens)}`,
  ];
  if (usage.reasoningTokens !== undefined) parts.push(`reasoning=${formatTokens(usage.reasoningTokens)}`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`prompt-cache-write=${formatTokens(usage.cacheWriteTokens)}`);
  return parts.join(" · ");
}

function formatToolHeadline(input: JsonObject): string {
  for (const key of ["path", "query", "url", "pattern"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return ` · ${key}=${singleLine(value, 100)}`;
  }
  return "";
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(redactSecrets(value as JsonValue));
    return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 3_999)}…`;
  } catch {
    return "[unserializable]";
  }
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "unreported";
  if (value < 1_000) return String(value);
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}k`;
}

function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${String(durationMs)}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function singleLine(value: string, maxChars: number): string {
  const normalized = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}
