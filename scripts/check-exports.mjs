import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const sourceFiles = await walkTypeScriptFiles(sourceRoot);
const testFiles = await walkTypeScriptFiles(path.join(projectRoot, "tests"));
const configPath = path.join(projectRoot, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
}
const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  projectRoot,
  { noEmit: true, rootDir: projectRoot },
  configPath,
);
const program = ts.createProgram({
  rootNames: [...sourceFiles, ...testFiles],
  options: parsedConfig.options,
});
const checker = program.getTypeChecker();
const exportedSymbols = new Map();

for (const fileName of sourceFiles) {
  const source = program.getSourceFile(fileName);
  if (!source) continue;
  visitExportedDeclarations(source, (nameNode) => {
    const symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) return;
    exportedSymbols.set(resolveAlias(symbol), {
      file: toProjectPath(fileName),
      name: nameNode.text,
      declaration: nameNode,
      references: 0,
    });
  });
}

for (const source of program.getSourceFiles()) {
  if (!isProjectFile(source.fileName)) continue;
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const record = exportedSymbols.get(resolveAlias(symbol));
        if (record && node !== record.declaration) {
          record.references += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const unused = [...exportedSymbols.values()]
  .filter((record) => record.references === 0)
  .sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));

if (unused.length > 0) {
  process.stderr.write("Exported declarations with no source or test references:\n");
  for (const record of unused) {
    process.stderr.write(`- ${record.file}: ${record.name}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Export check passed: ${String(exportedSymbols.size)} declarations are referenced by source or tests.\n`,
  );
}

function visitExportedDeclarations(source, onName) {
  const visit = (node) => {
    if (hasExportModifier(node)) {
      if (
        ts.isClassDeclaration(node)
        || ts.isFunctionDeclaration(node)
        || ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isEnumDeclaration(node)
      ) {
        if (node.name) onName(node.name);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          visitBindingName(declaration.name, onName);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function visitBindingName(name, onName) {
  if (ts.isIdentifier(name)) {
    onName(name);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) visitBindingName(element.name, onName);
  }
}

function hasExportModifier(node) {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function resolveAlias(symbol) {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function isProjectFile(fileName) {
  const relative = path.relative(projectRoot, fileName);
  return !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && !relative.includes(`${path.sep}node_modules${path.sep}`);
}

async function walkTypeScriptFiles(directory) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkTypeScriptFiles(target));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.resolve(target));
    }
  }
  return files;
}

function toProjectPath(file) {
  return path.relative(projectRoot, file).replaceAll(path.sep, "/");
}
