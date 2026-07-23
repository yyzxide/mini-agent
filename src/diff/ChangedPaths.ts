export function extractChangedPathsFromUnifiedDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      addPath(paths, line.slice(4));
    } else if (line.startsWith("rename to ")) {
      addPath(paths, line.slice("rename to ".length));
    } else if (line.startsWith("diff --git ")) {
      const match = /^diff --git\s+(?:"?a\/.+?"?)\s+(?:"?b\/.+?"?)$/.exec(line);
      if (match) {
        const parts = line.slice("diff --git ".length).match(/(?:"[^"]+"|\S+)/g);
        addPath(paths, parts?.[1]);
      }
    }
  }
  return [...paths];
}

export function extractFileDiffFromUnifiedDiff(diff: string, targetPath: string): string {
  const starts = [...diff.matchAll(/^diff --git /gm)]
    .flatMap((match) => match.index === undefined ? [] : [match.index]);
  for (const [index, start] of starts.entries()) {
    const segment = diff.slice(start, starts[index + 1] ?? diff.length).trimEnd();
    const header = segment.split(/\r?\n/, 1)[0] ?? "";
    const parts = header.slice("diff --git ".length).match(/(?:"[^"]+"|\S+)/g);
    const candidate = normalizeDiffPath(parts?.[1]);
    if (candidate === targetPath.replaceAll("\\", "/")) return segment;
  }
  return "";
}

function addPath(paths: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return;
  const path = normalizeDiffPath(rawPath);
  if (path && path !== "/dev/null") paths.add(path);
}

function normalizeDiffPath(rawPath: string | undefined): string {
  return (rawPath ?? "").trim()
    .replace(/^"|"$/g, "")
    .replace(/^[ab]\//, "")
    .replaceAll("\\", "/");
}
