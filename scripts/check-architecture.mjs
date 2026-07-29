import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const entryPoint = path.join(sourceRoot, "cli", "index.ts");
const sourceFiles = (await walkTypeScriptFiles(sourceRoot)).map((file) => path.resolve(file));
const sourceFileSet = new Set(sourceFiles);
const graph = new Map();
const unresolvedImports = [];
const sourceTextByFile = new Map();

const forbiddenControlPlaneFiles = new Set([
  "src/agent/ArtifactFollowUp.ts",
  "src/agent/ArtifactIntent.ts",
  "src/agent/ExternalFactPolicy.ts",
  "src/agent/FollowUpQuestionResolver.ts",
  "src/agent/ReadonlySubAgentCoordinator.ts",
  "src/agent/SubAgentIntent.ts",
  "src/agent/TaskConstraints.ts",
  "src/agent/TaskFollowUp.ts",
  "src/context/FilePlacementAdvisor.ts",
  "src/context/RepoScanner.ts",
  "src/diagnostics/ErrorClassifier.ts",
]);

const restrictedLegacyTokens = new Map([
  ["DIRECT_RESPONSE", new Set()],
  ["SINGLE_SHOT", new Set()],
  ["completeText", new Set()],
  ["web_rewrite", new Set()],
  ["looksLikeCompleteFileReadRequest", new Set()],
  ["TaskRouter", new Set()],
  ["TaskUnderstanding", new Set()],
  ["TaskContractBuilder", new Set()],
  ["LocalReply", new Set()],
  ["DIRECT_ANSWER", new Set([
    "src/cli/index.ts",
    "src/memory/MemoryTypes.ts",
    "src/session/TaskChangeLogStore.ts",
  ])],
  ["WEB_ANSWER", new Set([
    "src/cli/index.ts",
    "src/memory/MemoryTypes.ts",
    "src/session/TaskChangeLogStore.ts",
  ])],
  ["CODE_REVIEW", new Set([
    "src/cli/index.ts",
    "src/session/TaskChangeLogStore.ts",
  ])],
  ["DELEGATE_READONLY", new Set([
    "src/llm/DecisionParser.ts",
  ])],
]);

for (const file of sourceFiles) {
  const text = await fs.readFile(file, "utf8");
  sourceTextByFile.set(file, text);
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const dependencies = new Set();

  const visit = (node) => {
    const specifier = readModuleSpecifier(node);
    if (specifier?.startsWith(".")) {
      const resolved = resolveLocalModule(file, specifier, sourceFileSet);
      if (resolved) {
        dependencies.add(resolved);
      } else {
        unresolvedImports.push({
          file: toProjectPath(file),
          specifier,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  graph.set(file, dependencies);
}

const reachable = new Set();
const pending = [entryPoint];
while (pending.length > 0) {
  const file = pending.pop();
  if (!file || reachable.has(file)) continue;
  reachable.add(file);
  for (const dependency of graph.get(file) ?? []) {
    pending.push(dependency);
  }
}

const orphanedFiles = sourceFiles
  .filter((file) => !reachable.has(file))
  .map(toProjectPath)
  .sort();
const resurrectedControlPlaneFiles = sourceFiles
  .map(toProjectPath)
  .filter((file) => forbiddenControlPlaneFiles.has(file))
  .sort();
const legacyTokenViolations = [];
for (const [file, text] of sourceTextByFile) {
  const projectPath = toProjectPath(file);
  for (const [token, allowedFiles] of restrictedLegacyTokens) {
    if (text.includes(token) && !allowedFiles.has(projectPath)) {
      legacyTokenViolations.push(`${projectPath}: ${token}`);
    }
  }
}

if (
  unresolvedImports.length > 0
  || orphanedFiles.length > 0
  || resurrectedControlPlaneFiles.length > 0
  || legacyTokenViolations.length > 0
) {
  if (unresolvedImports.length > 0) {
    process.stderr.write("Unresolved local TypeScript imports:\n");
    for (const item of unresolvedImports) {
      process.stderr.write(`- ${item.file}: ${item.specifier}\n`);
    }
  }
  if (orphanedFiles.length > 0) {
    process.stderr.write("Source files unreachable from src/cli/index.ts:\n");
    for (const file of orphanedFiles) {
      process.stderr.write(`- ${file}\n`);
    }
  }
  if (resurrectedControlPlaneFiles.length > 0) {
    process.stderr.write("Removed control-plane files must not be restored:\n");
    for (const file of resurrectedControlPlaneFiles) {
      process.stderr.write(`- ${file}\n`);
    }
  }
  if (legacyTokenViolations.length > 0) {
    process.stderr.write("Legacy control-plane tokens outside compatibility boundaries:\n");
    for (const violation of legacyTokenViolations.sort()) {
      process.stderr.write(`- ${violation}\n`);
    }
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Architecture check passed: ${String(reachable.size)} source files are reachable and legacy control-plane boundaries are intact.\n`,
  );
}

function readModuleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier
    && ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

function resolveLocalModule(importer, specifier, files) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const withoutRuntimeExtension = unresolved.replace(/\.(?:mjs|cjs|js)$/, "");
  const candidates = [
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    path.join(withoutRuntimeExtension, "index.ts"),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

async function walkTypeScriptFiles(directory) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkTypeScriptFiles(target));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(target);
    }
  }
  return files;
}

function toProjectPath(file) {
  return path.relative(projectRoot, file).replaceAll(path.sep, "/");
}
