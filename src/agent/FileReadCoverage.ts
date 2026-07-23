export interface FileLineRange {
  startLine: number;
  endLine: number;
}

export interface FileReadCoverage {
  path: string;
  totalLines: number;
  ranges: FileLineRange[];
  complete: boolean;
  nextStartLine?: number;
  sourceVersion?: string;
  partialLine?: { line: number; nextColumn: number };
  readCalls: number;
}

export interface ReadFileResultData {
  path: string;
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
  totalLines: number;
  content: string;
  hasMore?: boolean;
  nextStartLine?: number;
  nextStartColumn?: number;
  lineComplete?: boolean;
  estimatedTokens?: number;
  sourceVersion?: string;
}

const COMPLETE_FILE_READ_PATTERN = /(?:完整|全部|全文|整个文件|全文件|从头到尾|逐行|读完|全部内容).{0,20}(?:读|读取|查看|检查|审查|分析)|(?:读|读取|查看|检查|审查|分析).{0,20}(?:完整|全部|全文|整个文件|全文件|从头到尾|逐行|读完|全部内容)|\b(?:read|inspect|review|analy[sz]e)\b.{0,24}\b(?:entire|whole|complete|full)\s+file\b|\b(?:entire|whole|complete|full)\s+file\b.{0,24}\b(?:read|inspect|review|analy[sz]e)\b/i;

export function looksLikeCompleteFileReadRequest(userGoal: string): boolean {
  return COMPLETE_FILE_READ_PATTERN.test(userGoal);
}

export function parseReadFileResultData(value: unknown): ReadFileResultData | undefined {
  if (!isRecord(value)) return undefined;
  const { path, startLine, endLine, totalLines, content } = value;
  if (
    typeof path !== "string"
    || !isNonNegativeInteger(totalLines)
    || !isPositiveInteger(startLine)
    || !isNonNegativeInteger(endLine)
    || typeof content !== "string"
  ) {
    return undefined;
  }
  return {
    path: normalizePath(path),
    startLine,
    ...(isPositiveInteger(value.startColumn) ? { startColumn: value.startColumn } : {}),
    endLine,
    ...(isNonNegativeInteger(value.endColumn) ? { endColumn: value.endColumn } : {}),
    totalLines,
    content,
    ...(typeof value.hasMore === "boolean" ? { hasMore: value.hasMore } : {}),
    ...(isPositiveInteger(value.nextStartLine) ? { nextStartLine: value.nextStartLine } : {}),
    ...(isPositiveInteger(value.nextStartColumn) ? { nextStartColumn: value.nextStartColumn } : {}),
    ...(typeof value.lineComplete === "boolean" ? { lineComplete: value.lineComplete } : {}),
    ...(isNonNegativeInteger(value.estimatedTokens) ? { estimatedTokens: value.estimatedTokens } : {}),
    ...(typeof value.sourceVersion === "string" ? { sourceVersion: value.sourceVersion } : {}),
  };
}

export function mergeFileReadCoverage(
  current: FileReadCoverage | undefined,
  result: ReadFileResultData,
): FileReadCoverage {
  const versionChanged = current !== undefined
    && result.sourceVersion !== undefined
    && current.sourceVersion !== undefined
    && result.sourceVersion !== current.sourceVersion;
  const sizeChangedWithoutVersion = current !== undefined
    && result.sourceVersion === undefined
    && current.sourceVersion === undefined
    && result.totalLines !== current.totalLines;
  const previousRanges = versionChanged || sizeChangedWithoutVersion ? [] : current?.ranges ?? [];
  const fragmentStart = result.startColumn ?? 1;
  const priorPartialMatches = current?.partialLine?.line === result.startLine
    && current.partialLine.nextColumn === fragmentStart;
  const completedFragmentLine = result.lineComplete !== false
    && (fragmentStart === 1 || priorPartialMatches);
  const observedRange = result.endLine >= result.startLine && completedFragmentLine
    ? [{ startLine: result.startLine, endLine: Math.min(result.endLine, result.totalLines) }]
    : [];
  const ranges = mergeRanges([...previousRanges, ...observedRange]);
  const nextStartLine = findFirstMissingLine(ranges, result.totalLines);
  const sourceVersion = result.sourceVersion ?? current?.sourceVersion;
  return {
    path: normalizePath(result.path),
    totalLines: result.totalLines,
    ranges,
    complete: nextStartLine === undefined,
    ...(nextStartLine !== undefined ? { nextStartLine } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    ...(result.lineComplete === false && result.nextStartColumn
      ? { partialLine: { line: result.startLine, nextColumn: result.nextStartColumn } }
      : {}),
    readCalls: versionChanged || sizeChangedWithoutVersion ? 1 : (current?.readCalls ?? 0) + 1,
  };
}

export function mergeFileReadCoverageList(
  current: FileReadCoverage[],
  result: ReadFileResultData,
): FileReadCoverage[] {
  const path = normalizePath(result.path);
  const existing = current.find((entry) => normalizePath(entry.path) === path);
  const merged = mergeFileReadCoverage(existing, result);
  return [...current.filter((entry) => normalizePath(entry.path) !== path), merged].slice(-20);
}

export function formatFileReadCoverage(values: FileReadCoverage[]): string {
  if (values.length === 0) return "(none)";
  return values.map((value) => {
    const ranges = value.ranges.length > 0
      ? value.ranges.map((range) => `${String(range.startLine)}-${String(range.endLine)}`).join(", ")
      : "(none)";
    const status = value.complete
      ? "complete"
      : `partial; next unread line ${String(value.nextStartLine ?? 1)}`;
    const fragment = value.partialLine
      ? `; partial line ${String(value.partialLine.line)} through column ${String(value.partialLine.nextColumn - 1)}`
      : "";
    return `${value.path}: ${status}; covered ${ranges} of ${String(value.totalLines)} lines${fragment}; reads=${String(value.readCalls)}`;
  }).join("\n");
}

export function normalizeReadPath(value: string): string {
  return normalizePath(value);
}

function mergeRanges(values: FileLineRange[]): FileLineRange[] {
  const sorted = values
    .filter((range) => range.startLine >= 1 && range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: FileLineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, range.endLine);
  }
  return merged;
}

function findFirstMissingLine(ranges: FileLineRange[], totalLines: number): number | undefined {
  if (totalLines === 0) return undefined;
  let cursor = 1;
  for (const range of ranges) {
    if (range.startLine > cursor) return cursor;
    cursor = Math.max(cursor, range.endLine + 1);
    if (cursor > totalLines) return undefined;
  }
  return cursor <= totalLines ? cursor : undefined;
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
