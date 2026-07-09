import path from "node:path";

export type DiagnosticCategory =
  | "WRONG_WORKING_DIRECTORY"
  | "COMMAND_NOT_FOUND"
  | "PORT_IN_USE"
  | "CONNECTION_REFUSED"
  | "PERMISSION_DENIED";

export type DiagnosticConfidence = "high" | "medium" | "low";

export interface ErrorClassifierInput {
  text: string;
  repoPath: string;
  lastCommand?: string;
}

export interface DiagnosticResult {
  category: DiagnosticCategory;
  confidence: DiagnosticConfidence;
  title: string;
  explanation: string;
  evidence: string[];
  suggestedCommands: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export function classifyErrorText(input: ErrorClassifierInput): DiagnosticResult | undefined {
  const text = input.text.trim();
  if (!text) {
    return undefined;
  }

  return classifyMissingPackageManifest(input, text)
    ?? classifyPortInUse(input, text)
    ?? classifyConnectionRefused(input, text)
    ?? classifyCommandNotFound(input, text)
    ?? classifyPermissionDenied(input, text);
}

export function hasHighConfidenceDiagnostic(input: ErrorClassifierInput): boolean {
  const diagnostic = classifyErrorText(input);
  return diagnostic?.confidence === "high";
}

function classifyMissingPackageManifest(input: ErrorClassifierInput, text: string): DiagnosticResult | undefined {
  const normalized = text.toLowerCase();
  if (!normalized.includes("package.json")) {
    return undefined;
  }

  const looksLikeMissingManifest = normalized.includes("enoent")
    && (
      normalized.includes("could not read package.json")
      || normalized.includes("no such file or directory")
      || normalized.includes("npm error path")
      || normalized.includes("npm err! path")
      || normalized.includes("pnpm")
      || normalized.includes("yarn")
    );
  if (!looksLikeMissingManifest) {
    return undefined;
  }

  const manifestPath = extractPackageJsonPath(text);
  const attemptedDirectory = manifestPath ? path.dirname(manifestPath) : undefined;
  const command = extractPromptCommand(text) ?? input.lastCommand ?? "npm run <script>";
  const packageManager = inferPackageManager(command, text);
  const scriptName = extractScriptName(command);
  const suggestedScriptCommand = scriptName
    ? `${packageManager} run ${scriptName}`
    : command;

  const evidence = [
    manifestPath ? `报错路径指向 ${manifestPath}` : "错误信息提到了缺失 package.json",
    attemptedDirectory ? `命令执行目录看起来是 ${attemptedDirectory}` : undefined,
  ].filter((item): item is string => item !== undefined);

  const explanation = attemptedDirectory && path.resolve(attemptedDirectory) !== path.resolve(input.repoPath)
    ? `包管理器是在 ${attemptedDirectory} 里查找 package.json，但当前仓库是 ${input.repoPath}。这通常说明命令在错误目录执行了。`
    : `包管理器在当前工作目录没有找到 package.json。请先进入包含 package.json 的项目目录，再运行脚本。`;

  return {
    category: "WRONG_WORKING_DIRECTORY",
    confidence: "high",
    title: "包管理器没有在当前运行目录找到 package.json",
    explanation,
    evidence,
    suggestedCommands: [
      `cd ${quoteShellArgument(input.repoPath)}`,
      suggestedScriptCommand,
      `${packageManager} --prefix ${quoteShellArgument(input.repoPath)} run ${scriptName ?? "<script>"}`,
    ],
    metadata: {
      repoPath: input.repoPath,
      manifestPath: manifestPath ?? null,
      attemptedDirectory: attemptedDirectory ?? null,
      packageManager,
      scriptName: scriptName ?? null,
    },
  };
}

function classifyCommandNotFound(input: ErrorClassifierInput, text: string): DiagnosticResult | undefined {
  const command = extractCommandNotFoundName(text);
  if (!command) {
    return undefined;
  }

  return {
    category: "COMMAND_NOT_FOUND",
    confidence: "high",
    title: `命令不存在或不在 PATH 中：${command}`,
    explanation: `系统找不到 ${command}。这通常是依赖未安装、工具未加入 PATH，或需要先在项目目录安装依赖。`,
    evidence: [`错误信息包含 command not found: ${command}`],
    suggestedCommands: [
      `cd ${quoteShellArgument(input.repoPath)}`,
      "npm install",
      `which ${quoteShellArgument(command)}`,
    ],
    metadata: {
      command,
      repoPath: input.repoPath,
    },
  };
}

function classifyPortInUse(input: ErrorClassifierInput, text: string): DiagnosticResult | undefined {
  const port = extractPortInUse(text);
  if (port === undefined) {
    return undefined;
  }

  return {
    category: "PORT_IN_USE",
    confidence: "high",
    title: `端口 ${String(port)} 已被占用`,
    explanation: `服务启动失败是因为端口 ${String(port)} 已经有进程在监听。需要停止占用进程，或把当前服务改到其它端口。`,
    evidence: [`错误信息显示端口 ${String(port)} already in use / EADDRINUSE`],
    suggestedCommands: [
      `ss -ltnp | grep ${String(port)}`,
      `lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
    ],
    metadata: {
      port,
      repoPath: input.repoPath,
    },
  };
}

function classifyConnectionRefused(input: ErrorClassifierInput, text: string): DiagnosticResult | undefined {
  const target = extractConnectionRefusedTarget(text);
  if (!target) {
    return undefined;
  }

  return {
    category: "CONNECTION_REFUSED",
    confidence: "high",
    title: `连接被拒绝：${target}`,
    explanation: `客户端访问了 ${target}，但目标地址没有服务在监听，或服务还没启动完成。`,
    evidence: [`错误信息包含 ECONNREFUSED / Connection refused: ${target}`],
    suggestedCommands: [
      `curl -v ${target}`,
      "检查后端服务、数据库或依赖容器是否已启动",
    ],
    metadata: {
      target,
      repoPath: input.repoPath,
    },
  };
}

function classifyPermissionDenied(input: ErrorClassifierInput, text: string): DiagnosticResult | undefined {
  if (!/\b(EACCES|permission denied)\b/i.test(text)) {
    return undefined;
  }

  return {
    category: "PERMISSION_DENIED",
    confidence: "medium",
    title: "权限不足",
    explanation: "当前用户没有执行该文件、读取该路径或写入目标目录的权限。需要确认文件权限和运行用户，而不是直接用高权限命令硬冲。",
    evidence: ["错误信息包含 EACCES / Permission denied"],
    suggestedCommands: [
      "ls -la <path>",
      "chmod +x <file>",
    ],
    metadata: {
      repoPath: input.repoPath,
    },
  };
}

function extractPackageJsonPath(text: string): string | undefined {
  const patterns = [
    /(?:npm\s+(?:error|err!)\s+path)\s+([^\r\n]+?package\.json)\b/i,
    /\bpath\s+([^\r\n]+?package\.json)\b/i,
    /\bopen\s+['"]([^'"]+?package\.json)['"]/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function extractPromptCommand(text: string): string | undefined {
  const match = /(?:^|\n)[^\n$]*\$\s*([^\n]+)/.exec(text);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : undefined;
}

function inferPackageManager(command: string, text: string): "npm" | "pnpm" | "yarn" {
  const source = `${command}\n${text}`.toLowerCase();
  if (/\bpnpm\b/.test(source)) {
    return "pnpm";
  }
  if (/\byarn\b/.test(source)) {
    return "yarn";
  }
  return "npm";
}

function extractScriptName(command: string): string | undefined {
  const match = /\b(?:npm|pnpm|yarn)\s+run\s+([^\s]+)/i.exec(command);
  return match?.[1]?.trim();
}

function extractCommandNotFoundName(text: string): string | undefined {
  const patterns = [
    /(?:^|\n)\s*(?:bash|zsh|sh):\s*([^:\s]+):\s*command not found\b/i,
    /(?:^|\n)\s*([^:\s]+):\s*command not found\b/i,
    /'([^']+)'\s+is not recognized as an internal or external command/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const command = match?.[1]?.trim();
    if (command) {
      return command;
    }
  }

  return undefined;
}

function extractPortInUse(text: string): number | undefined {
  const patterns = [
    /\bport\s+(\d{2,5})\s+(?:was\s+)?already in use\b/i,
    /\bEADDRINUSE\b[^\n]*(?::|port\s+)(\d{2,5})\b/i,
    /\baddress already in use\b[^\n]*(?::|port\s+)(\d{2,5})\b/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const port = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }

  return undefined;
}

function extractConnectionRefusedTarget(text: string): string | undefined {
  const patterns = [
    /\bECONNREFUSED\b[^\n]*?(?:https?:\/\/)?([A-Za-z0-9_.-]+:\d{2,5})/i,
    /\bConnection refused\b[^\n]*?(?:https?:\/\/)?([A-Za-z0-9_.-]+:\d{2,5})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const target = match?.[1]?.trim();
    if (target) {
      return target;
    }
  }

  return undefined;
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}
