import { estimateTokens, truncateToTokenBudget } from "./TokenEstimator.js";

export type CompactionBucket = "PINNED" | "CONVERSATION" | "EVIDENCE";

export interface StructuredCompactionItem {
  sourceId: string;
  content: string;
  bucket: CompactionBucket;
  priority: number;
  reason: string;
  order: number;
}

export interface StructuredCompactionSelection {
  sourceId: string;
  bucket: CompactionBucket;
  reason: string;
  clipped: boolean;
  estimatedTokens: number;
}

export interface StructuredCompactionTrace {
  strategy: "structured-salience-v2";
  inputItems: number;
  selectedItems: number;
  droppedItems: number;
  clippedItems: number;
  pinnedItems: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  selections: StructuredCompactionSelection[];
}

export interface StructuredCompactionResult {
  text: string;
  trace: StructuredCompactionTrace;
}

export function compactStructuredItems(
  items: StructuredCompactionItem[],
  options: { maxChars: number; maxTokens: number },
): StructuredCompactionResult {
  const normalized = deduplicateItems(items)
    .map((item) => prepareItem(item, options))
    .filter((item) => item.content.length > 0);
  const selected = new Map<string, PreparedCompactionItem>();
  const bucketShares: Record<CompactionBucket, number> = {
    PINNED: 0.38,
    CONVERSATION: 0.42,
    EVIDENCE: 0.12,
  };

  for (const bucket of ["PINNED", "CONVERSATION", "EVIDENCE"] as const) {
    const candidates = normalized
      .filter((item) => item.bucket === bucket)
      .sort(compareCandidates);
    selectWithinBudget(
      candidates,
      Math.floor(options.maxChars * bucketShares[bucket]),
      Math.floor(options.maxTokens * bucketShares[bucket]),
      selected,
    );
  }

  const remaining = normalized
    .filter((item) => !selected.has(item.sourceId))
    .sort(compareCandidates);
  for (const item of remaining) {
    const trial = new Map(selected);
    trial.set(item.sourceId, item);
    if (fits(renderSelected(trial), options)) {
      selected.set(item.sourceId, item);
    }
  }

  // Extremely small budgets can leave every quota empty. Preserve at least the
  // newest highest-salience item, clipped to the available budget.
  if (selected.size === 0 && normalized.length > 0) {
    const first = [...normalized].sort(compareCandidates)[0]!;
    selected.set(first.sourceId, clipPreparedItem(first, options.maxChars - 96, options.maxTokens - 24));
  }

  let text = renderSelected(selected);
  if (!fits(text, options)) {
    text = truncateChars(
      truncateToTokenBudget(text, options.maxTokens, "head_tail").text,
      options.maxChars,
    );
  }
  const selections = [...selected.values()]
    .sort((left, right) => left.order - right.order)
    .map((item) => ({
      sourceId: item.sourceId,
      bucket: item.bucket,
      reason: item.reason,
      clipped: item.clipped,
      estimatedTokens: estimateTokens(item.content),
    }));
  return {
    text,
    trace: {
      strategy: "structured-salience-v2",
      inputItems: items.length,
      selectedItems: selections.length,
      droppedItems: Math.max(0, items.length - selections.length),
      clippedItems: selections.filter((item) => item.clipped).length,
      pinnedItems: selections.filter((item) => item.bucket === "PINNED").length,
      estimatedInputTokens: items.reduce((total, item) => total + estimateTokens(item.content), 0),
      estimatedOutputTokens: estimateTokens(text),
      selections,
    },
  };
}

interface PreparedCompactionItem extends StructuredCompactionItem {
  clipped: boolean;
}

function prepareItem(
  item: StructuredCompactionItem,
  options: { maxChars: number; maxTokens: number },
): PreparedCompactionItem {
  const maxItemChars = item.bucket === "EVIDENCE"
    ? Math.min(1_200, Math.floor(options.maxChars * 0.18))
    : Math.min(2_400, Math.floor(options.maxChars * 0.3));
  const maxItemTokens = item.bucket === "EVIDENCE"
    ? Math.min(300, Math.floor(options.maxTokens * 0.18))
    : Math.min(600, Math.floor(options.maxTokens * 0.3));
  return clipPreparedItem({ ...item, clipped: false }, maxItemChars, maxItemTokens);
}

function clipPreparedItem(
  item: PreparedCompactionItem,
  maxChars: number,
  maxTokens: number,
): PreparedCompactionItem {
  const tokenLimited = truncateToTokenBudget(item.content, Math.max(1, maxTokens), "head_tail");
  const charLimited = truncateChars(tokenLimited.text, Math.max(1, maxChars));
  return {
    ...item,
    content: charLimited,
    clipped: item.clipped || tokenLimited.truncated || charLimited !== tokenLimited.text,
  };
}

function selectWithinBudget(
  candidates: PreparedCompactionItem[],
  maxChars: number,
  maxTokens: number,
  selected: Map<string, PreparedCompactionItem>,
): void {
  let usedChars = 0;
  let usedTokens = 0;
  for (const item of candidates) {
    const itemTokens = estimateTokens(item.content);
    if (usedChars + item.content.length <= maxChars && usedTokens + itemTokens <= maxTokens) {
      selected.set(item.sourceId, item);
      usedChars += item.content.length;
      usedTokens += itemTokens;
    }
  }
}

function renderSelected(selected: Map<string, PreparedCompactionItem>): string {
  const values = [...selected.values()];
  return [
    "[structured session compaction v2]",
    renderBucket("Pinned constraints and outcomes", values, "PINNED"),
    renderBucket("Recent conversation", values, "CONVERSATION"),
    renderBucket("Recent execution evidence", values, "EVIDENCE"),
  ].join("\n");
}

function renderBucket(
  title: string,
  values: PreparedCompactionItem[],
  bucket: CompactionBucket,
): string {
  const items = values
    .filter((item) => item.bucket === bucket)
    .sort((left, right) => left.order - right.order);
  return [
    `${title}:`,
    ...(items.length > 0
      ? items.map((item) => `${item.content} (source:${item.sourceId})`)
      : ["(none selected)"]),
  ].join("\n");
}

function compareCandidates(left: PreparedCompactionItem, right: PreparedCompactionItem): number {
  return right.priority - left.priority || right.order - left.order;
}

function fits(value: string, options: { maxChars: number; maxTokens: number }): boolean {
  return value.length <= options.maxChars && estimateTokens(value) <= options.maxTokens;
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = " ...[item compacted]... ";
  const contentBudget = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(contentBudget * 0.4);
  return `${value.slice(0, headChars)}${marker}${value.slice(-(contentBudget - headChars))}`;
}

function deduplicateItems(items: StructuredCompactionItem[]): StructuredCompactionItem[] {
  const seen = new Set<string>();
  const selected: StructuredCompactionItem[] = [];
  for (const item of [...items].reverse()) {
    const key = item.content.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.unshift(item);
  }
  return selected;
}
