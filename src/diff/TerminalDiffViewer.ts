import type { TaskDiffArtifact, TaskDiffFile } from "./TaskDiffTypes.js";
import { extractFileDiffFromUnifiedDiff } from "./ChangedPaths.js";
import { sanitizeTerminalText } from "../observability/TerminalSanitizer.js";

export interface DiffViewerRenderOptions {
  columns?: number;
  rows?: number;
  selectedFile?: number;
  scrollOffset?: number;
  color?: boolean;
}

export interface TerminalDiffViewerOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

const ALT_SCREEN_ON = "\u001B[?1049h";
const ALT_SCREEN_OFF = "\u001B[?1049l";
const CURSOR_HIDE = "\u001B[?25l";
const CURSOR_SHOW = "\u001B[?25h";
const MOUSE_ON = "\u001B[?1000h\u001B[?1006h";
const MOUSE_OFF = "\u001B[?1000l\u001B[?1006l";

export function renderChangesCard(
  artifact: TaskDiffArtifact,
  color = process.stdout.isTTY === true,
  interactive = false,
): string {
  const marker = paint(color, "cyan", "◆");
  const stats = `${String(artifact.fileCount)} file${artifact.fileCount === 1 ? "" : "s"} · +${String(artifact.additions)} -${String(artifact.deletions)}`;
  const files = artifact.files.slice(0, 5).map((file) => (
    `│  ${changeMarker(file.changeType)} ${sanitizeTerminalText(file.path)}`
  ));
  if (artifact.files.length > 5) files.push(`│  … ${String(artifact.files.length - 5)} more files`);
  return [
    `${marker} [changes] ${stats}`,
    ...files,
    interactive
      ? "│  └─ [ View changes ]"
      : `│  └─ View: mini-agent diff --session ${artifact.sessionId}`,
  ].join("\n");
}

export async function promptTaskDiffAction(
  artifact: TaskDiffArtifact,
  options: TerminalDiffViewerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return;
  }

  output.write("\u001B[36mchanges>\u001B[0m Enter/click View changes · Esc continue ");
  const choice = await readActionChoice(input, output);
  output.write("\r\u001B[2K");
  if (choice === "view") {
    await showTaskDiffViewer(artifact, { input, output });
  }
}

export async function showTaskDiffViewer(
  artifact: TaskDiffArtifact,
  options: TerminalDiffViewerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    output.write(sanitizeTerminalText(artifact.unifiedDiff) || "[diff] No task changes.\n");
    return;
  }

  const wasRaw = input.isRaw === true;
  let selectedFile = 0;
  let scrollOffset = 0;
  const render = (): void => {
    output.write("\u001B[2J\u001B[H");
    output.write(renderDiffViewerFrame(artifact, {
      columns: output.columns ?? 120,
      rows: output.rows ?? 36,
      selectedFile,
      scrollOffset,
      color: true,
    }));
  };

  input.setRawMode(true);
  input.resume();
  output.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}${MOUSE_ON}`);
  render();

  try {
    while (true) {
      const data = await readInput(input);
      const text = data.toString("utf8");
      if (text === "q" || text === "Q" || text === "\u001B" || text === "\u0003") break;
      if (text === "\u001B[A") {
        selectedFile = Math.max(0, selectedFile - 1);
        scrollOffset = 0;
      } else if (text === "\u001B[B") {
        selectedFile = Math.min(Math.max(0, artifact.files.length - 1), selectedFile + 1);
        scrollOffset = 0;
      } else if (text === "\u001B[5~") {
        scrollOffset = Math.max(0, scrollOffset - Math.max(4, (output.rows ?? 36) - 8));
      } else if (text === "\u001B[6~") {
        scrollOffset += Math.max(4, (output.rows ?? 36) - 8);
      } else {
        const mouse = parseSgrMouse(text);
        if (mouse?.kind === "wheel-up") scrollOffset = Math.max(0, scrollOffset - 3);
        if (mouse?.kind === "wheel-down") scrollOffset += 3;
        const visibleFileRows = Math.max(1, (output.rows ?? 36) - 4);
        if (mouse?.kind === "click" && mouse.y >= 4 && mouse.y < 4 + visibleFileRows) {
          const fileStart = Math.floor(selectedFile / visibleFileRows) * visibleFileRows;
          selectedFile = Math.min(artifact.files.length - 1, fileStart + mouse.y - 4);
          scrollOffset = 0;
        }
      }
      render();
    }
  } finally {
    output.write(`${MOUSE_OFF}${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    input.setRawMode(wasRaw);
    if (!wasRaw) input.pause();
  }
}

export function renderDiffViewerFrame(
  artifact: TaskDiffArtifact,
  options: DiffViewerRenderOptions = {},
): string {
  const columns = Math.max(60, options.columns ?? 120);
  const rows = Math.max(12, options.rows ?? 36);
  const color = options.color ?? false;
  const selectedFile = clamp(options.selectedFile ?? 0, 0, Math.max(0, artifact.files.length - 1));
  const file = artifact.files[selectedFile];
  const sidebarWidth = Math.min(38, Math.max(22, Math.floor(columns * 0.3)));
  const diffWidth = Math.max(20, columns - sidebarWidth - 3);
  const bodyRows = rows - 4;
  const selectedDiff = file
    ? extractFileDiffFromUnifiedDiff(artifact.unifiedDiff, file.path)
    : artifact.unifiedDiff;
  const diffLines = (selectedDiff || artifact.unifiedDiff || "[No task changes]").split(/\r?\n/);
  const maxScroll = Math.max(0, diffLines.length - bodyRows);
  const scrollOffset = clamp(options.scrollOffset ?? 0, 0, maxScroll);
  const visibleDiff = diffLines.slice(scrollOffset, scrollOffset + bodyRows);
  const fileStart = Math.floor(selectedFile / Math.max(1, bodyRows)) * Math.max(1, bodyRows);
  const lines = [
    fitLine(`Changes · ${String(artifact.fileCount)} file${artifact.fileCount === 1 ? "" : "s"} · +${String(artifact.additions)} -${String(artifact.deletions)}`, columns),
    `${fitLine("Files", sidebarWidth)} │ ${fitLine(file?.path ?? "Diff", diffWidth)}`,
    `${"─".repeat(sidebarWidth)}─┼─${"─".repeat(diffWidth)}`,
  ];

  for (let row = 0; row < bodyRows; row += 1) {
    const candidateIndex = fileStart + row;
    const candidate = artifact.files[candidateIndex];
    const selected = candidateIndex === selectedFile;
    const fileText = candidate
      ? `${selected ? ">" : " "} ${changeMarker(candidate.changeType)} ${candidate.path}`
      : "";
    const sidebar = selected ? paint(color, "cyan", fitLine(fileText, sidebarWidth)) : fitLine(fileText, sidebarWidth);
    const diff = colorDiffLine(visibleDiff[row] ?? "", diffWidth, color);
    lines.push(`${sidebar} │ ${diff}`);
  }
  lines.push(fitLine("↑↓ file · PgUp/PgDn or wheel scroll · click file · q/Esc back", columns));
  return lines.join("\n");
}

function readActionChoice(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<"view" | "continue"> {
  const wasRaw = input.isRaw === true;
  input.setRawMode?.(true);
  input.resume();
  output.write(MOUSE_ON);
  return new Promise((resolve) => {
    const onData = (data: Buffer): void => {
      const text = data.toString("utf8");
      const mouse = parseSgrMouse(text);
      const view = text === "\r" || text === "\n" || text.toLowerCase() === "v"
        || (mouse?.kind === "click" && mouse.x <= 22);
      const shouldContinue = text === "\u001B" || text.toLowerCase() === "q" || text.toLowerCase() === "c"
        || text === "\u0003"
        || (mouse?.kind === "click" && mouse.x > 22);
      if (!view && !shouldContinue) return;
      input.off("data", onData);
      output.write(MOUSE_OFF);
      input.setRawMode?.(wasRaw);
      if (!wasRaw) input.pause();
      resolve(view ? "view" : "continue");
    };
    input.on("data", onData);
  });
}

function readInput(input: NodeJS.ReadStream): Promise<Buffer> {
  return new Promise((resolve) => input.once("data", (data: Buffer) => resolve(data)));
}

function parseSgrMouse(value: string): { kind: "click" | "wheel-up" | "wheel-down"; x: number; y: number } | undefined {
  const match = value.match(/\u001B\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return undefined;
  const button = Number.parseInt(match[1] ?? "", 10);
  const x = Number.parseInt(match[2] ?? "", 10);
  const y = Number.parseInt(match[3] ?? "", 10);
  if (![button, x, y].every(Number.isFinite)) return undefined;
  if (button === 64) return { kind: "wheel-up", x, y };
  if (button === 65) return { kind: "wheel-down", x, y };
  if (button === 0 && match[4] === "M") return { kind: "click", x, y };
  return undefined;
}

function colorDiffLine(value: string, width: number, color: boolean): string {
  const fitted = fitLine(value, width);
  if (value.startsWith("+") && !value.startsWith("+++")) return paint(color, "green", fitted);
  if (value.startsWith("-") && !value.startsWith("---")) return paint(color, "red", fitted);
  if (value.startsWith("@@")) return paint(color, "cyan", fitted);
  if (value.startsWith("diff --git") || value.startsWith("+++ ") || value.startsWith("--- ")) {
    return paint(color, "yellow", fitted);
  }
  return fitted;
}

function changeMarker(changeType: TaskDiffFile["changeType"]): string {
  switch (changeType) {
    case "ADDED": return "A";
    case "MODIFIED": return "M";
    case "DELETED": return "D";
    case "RENAMED": return "R";
    case "COPIED": return "C";
    case "UNKNOWN": return "?";
  }
}

function fitLine(value: string, width: number): string {
  const normalized = sanitizeTerminalText(value).replace(/\t/g, "  ");
  const visible = normalized.length > width
    ? `${normalized.slice(0, Math.max(0, width - 1))}…`
    : normalized;
  return visible.padEnd(width, " ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function paint(enabled: boolean, color: "cyan" | "green" | "red" | "yellow", value: string): string {
  if (!enabled) return value;
  const code = { cyan: 36, green: 32, red: 31, yellow: 33 }[color];
  return `\u001B[${String(code)}m${value}\u001B[0m`;
}
