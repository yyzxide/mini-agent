import type {
  ContextPlan,
  ContextRetention,
  ContextSectionCandidate,
  ContextSectionTrace,
  TaskPhase,
} from "./ContextTypes.js";
import { estimateTokens, truncateToTokenBudget } from "./TokenEstimator.js";

export interface ContextPlannerOptions {
  maxChars?: number;
  maxTokens?: number;
}

const DEFAULT_MAX_CHARS = 30_000;
const DEFAULT_MAX_TOKENS = 7_500;

export class ContextPlanner {
  private readonly maxChars: number;
  private readonly maxTokens: number;

  constructor(options: ContextPlannerOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxTokens = options.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, Math.ceil(this.maxChars / 4));
  }

  plan(phase: TaskPhase, candidates: ContextSectionCandidate[]): ContextPlan {
    const enabled = candidates.filter((candidate) => candidate.enabled !== false && candidate.content.trim().length > 0);
    const allocationOrder = [...enabled].sort((left, right) => {
      if (Boolean(left.required) !== Boolean(right.required)) {
        return left.required ? -1 : 1;
      }
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      if (Boolean(left.stable) !== Boolean(right.stable)) {
        return left.stable ? -1 : 1;
      }
      return candidates.indexOf(left) - candidates.indexOf(right);
    });

    const traceById = new Map<string, ContextSectionTrace>();
    for (const candidate of candidates) {
      traceById.set(candidate.id, createSkippedTrace(candidate));
    }

    const parts: string[] = [];
    let remainingTokens = this.maxTokens;
    let remainingChars = this.maxChars;

    for (const [candidateIndex, candidate] of allocationOrder.entries()) {
      const separator = parts.length === 0 ? "" : "\n\n---\n\n";
      const header = `${candidate.title}:\n`;
      const overheadChars = separator.length + header.length;
      const overheadTokens = estimateTokens(separator + header);
      const minimumTokens = candidate.minTokens ?? (candidate.required ? 24 : 48);
      const laterRequired = allocationOrder.slice(candidateIndex + 1).filter((item) => item.required);
      const reservedTokens = candidate.required
        ? laterRequired.reduce((total, item) => total + (item.minTokens ?? 24) + estimateTokens(`${item.title}:\n`), 0)
        : 0;
      const reservedChars = candidate.required ? laterRequired.length * 48 : 0;
      const availableTokens = Math.max(0, remainingTokens - overheadTokens - reservedTokens);
      const availableChars = Math.max(0, remainingChars - overheadChars - reservedChars);
      if (availableTokens < minimumTokens || availableChars < 32) {
        const trace = traceById.get(candidate.id);
        if (trace) {
          trace.reason = candidate.required
            ? `${candidate.reason}; required section could not fit the remaining budget`
            : `${candidate.reason}; skipped because higher-priority context consumed the budget`;
        }
        continue;
      }

      const sectionTokenBudget = Math.min(candidate.maxTokens ?? availableTokens, availableTokens);
      const tokenLimited = truncateToTokenBudget(
        normalizeContent(candidate.content),
        sectionTokenBudget,
        candidate.retention ?? "head",
      );
      const charLimited = truncateToCharBudget(tokenLimited.text, availableChars, candidate.retention ?? "head");
      if (!charLimited.text) {
        continue;
      }

      const rendered = `${separator}${header}${charLimited.text}`;
      parts.push(rendered);
      remainingChars -= rendered.length;
      remainingTokens -= estimateTokens(rendered);
      traceById.set(candidate.id, {
        id: candidate.id,
        title: candidate.title,
        priority: candidate.priority,
        required: candidate.required === true,
        stable: candidate.stable === true,
        selected: true,
        truncated: tokenLimited.truncated || charLimited.truncated,
        estimatedTokens: estimateTokens(candidate.content),
        includedTokens: estimateTokens(charLimited.text),
        includedChars: charLimited.text.length,
        reason: candidate.reason,
      });
    }

    const context = parts.join("");
    return {
      context,
      trace: {
        version: 2,
        phase,
        maxChars: this.maxChars,
        maxTokens: this.maxTokens,
        totalChars: context.length,
        totalEstimatedTokens: estimateTokens(context),
        sections: candidates.map((candidate) => traceById.get(candidate.id) ?? createSkippedTrace(candidate)),
      },
    };
  }
}

function createSkippedTrace(candidate: ContextSectionCandidate): ContextSectionTrace {
  return {
    id: candidate.id,
    title: candidate.title,
    priority: candidate.priority,
    required: candidate.required === true,
    stable: candidate.stable === true,
    selected: false,
    truncated: false,
    estimatedTokens: estimateTokens(candidate.content),
    includedTokens: 0,
    includedChars: 0,
    reason: candidate.enabled === false ? `${candidate.reason}; not relevant in the current phase` : candidate.reason,
  };
}

function normalizeContent(value: string): string {
  return value.trim().length > 0 ? value.trim() : "(empty)";
}

function truncateToCharBudget(
  value: string,
  maxChars: number,
  retention: ContextRetention,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  if (maxChars <= 0) {
    return { text: "", truncated: true };
  }
  const marker = "\n...[context truncated]...\n";
  const budget = Math.max(0, maxChars - marker.length);
  if (retention === "tail") {
    return { text: `${marker.trimStart()}${value.slice(-budget)}`.slice(-maxChars), truncated: true };
  }
  if (retention === "head_tail") {
    const headChars = Math.floor(budget * 0.4);
    const tailChars = Math.max(0, budget - headChars);
    return { text: `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`, truncated: true };
  }
  return { text: `${value.slice(0, budget)}${marker.trimEnd()}`.slice(0, maxChars), truncated: true };
}
