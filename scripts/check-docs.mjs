import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = [
  path.join(projectRoot, "README.md"),
  ...await walkMarkdownFiles(path.join(projectRoot, "docs")),
];
const failures = [];

for (const file of markdownFiles) {
  const text = await fs.readFile(file, "utf8");
  for (const target of readMarkdownTargets(text)) {
    if (isExternalTarget(target) || target.startsWith("#")) continue;
    const localTarget = decodeURIComponent(target.split("#", 1)[0] ?? "");
    if (!localTarget) continue;
    const absoluteTarget = path.resolve(path.dirname(file), localTarget);
    if (!isInsideProject(absoluteTarget) || !await exists(absoluteTarget)) {
      failures.push(`${toProjectPath(file)}: missing local link ${target}`);
    }
  }

  for (const referencedPath of readInlineProjectPaths(text)) {
    const absoluteTarget = path.resolve(projectRoot, referencedPath);
    if (!await exists(absoluteTarget)) {
      failures.push(`${toProjectPath(file)}: missing referenced path ${referencedPath}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("Documentation consistency check failed:\n");
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Documentation check passed: ${String(markdownFiles.length)} Markdown files have valid local references.\n`,
  );
}

function readMarkdownTargets(text) {
  const targets = [];
  const pattern = /!?\[[^\]]*]\((?:<([^>]+)>|([^)]+))\)/g;
  for (const match of text.matchAll(pattern)) {
    const rawTarget = (match[1] ?? match[2] ?? "").trim();
    const target = rawTarget.replace(/\s+["'][^"']*["']$/, "");
    if (target) targets.push(target);
  }
  return targets;
}

function readInlineProjectPaths(text) {
  const paths = [];
  const pattern = /`((?:src|tests|scripts|docs|benchmarks)\/[^`\s,;:()]+)`/g;
  for (const match of text.matchAll(pattern)) {
    const referencedPath = (match[1] ?? "").replace(/[.。]+$/, "");
    if (!referencedPath || /[*?[\]{}]/.test(referencedPath)) continue;
    paths.push(referencedPath);
  }
  return paths;
}

function isExternalTarget(target) {
  return /^(?:https?:|mailto:|data:)/i.test(target);
}

function isInsideProject(target) {
  const relative = path.relative(projectRoot, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function walkMarkdownFiles(directory) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(target));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(target);
    }
  }
  return files;
}

function toProjectPath(file) {
  return path.relative(projectRoot, file).replaceAll(path.sep, "/");
}
