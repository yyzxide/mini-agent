import type { RagChunkDraft } from "./RagTypes.js";

export interface TextChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

interface LineUnit {
  text: string;
  line: number;
  heading?: string;
}

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 180;
const MIN_CHUNK_SIZE = 200;

export function chunkText(text: string, options: TextChunkOptions = {}): RagChunkDraft[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  validateChunkOptions(chunkSize, overlap);

  const units = toLineUnits(text, chunkSize);
  const chunks: RagChunkDraft[] = [];
  let cursor = 0;

  while (cursor < units.length) {
    const selected: LineUnit[] = [];
    let chars = 0;
    let nextCursor = cursor;

    while (nextCursor < units.length) {
      const unit = units[nextCursor];
      if (!unit) break;
      const addition = unit.text.length + (selected.length > 0 ? 1 : 0);
      if (selected.length > 0 && chars + addition > chunkSize) break;
      selected.push(unit);
      chars += addition;
      nextCursor += 1;
    }

    const content = selected.map((unit) => unit.text).join("\n").trim();
    if (content.length > 0) {
      const first = selected[0];
      const last = selected[selected.length - 1];
      if (first && last) {
        chunks.push({
          text: content,
          startLine: first.line,
          endLine: last.line,
          chunkIndex: chunks.length,
          ...(last.heading ? { heading: last.heading } : first.heading ? { heading: first.heading } : {}),
        });
      }
    }

    if (nextCursor >= units.length) break;
    let retainedChars = 0;
    let overlapStart = nextCursor;
    while (overlapStart > cursor && retainedChars < overlap) {
      overlapStart -= 1;
      retainedChars += (units[overlapStart]?.text.length ?? 0) + 1;
    }
    cursor = Math.max(cursor + 1, overlapStart);
  }

  return chunks;
}

function toLineUnits(text: string, chunkSize: number): LineUnit[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const units: LineUnit[] = [];
  let heading: string | undefined;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd();
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (headingMatch?.[1]) heading = headingMatch[1].trim();

    if (line.length <= chunkSize) {
      units.push({ text: line, line: index + 1, ...(heading ? { heading } : {}) });
      continue;
    }

    for (let offset = 0; offset < line.length; offset += chunkSize) {
      units.push({
        text: line.slice(offset, offset + chunkSize),
        line: index + 1,
        ...(heading ? { heading } : {}),
      });
    }
  }

  return units;
}

function validateChunkOptions(chunkSize: number, overlap: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE) {
    throw new Error(`RAG chunkSize must be an integer >= ${MIN_CHUNK_SIZE}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error("RAG overlap must be an integer >= 0 and smaller than chunkSize");
  }
}
