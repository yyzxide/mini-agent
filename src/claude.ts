#!/usr/bin/env node

/**
 * claude.ts — 简易版 Claude Code
 * 交互式 REPL，支持文件读写、命令执行、代码搜索
 * 使用 Anthropic API (claude-sonnet-4-20250514)
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFile, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { readdir } from "node:fs/promises";

// ---------- 配置 ----------
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_HISTORY = 20; // 保留最近轮次
const SYSTEM_PROMPT = `你是 Claude Code，一个直接在用户终端中工作的 AI 编程助手。
你可以使用以下工具来协助用户：
- read_file：读取文件内容。参数：path (string)
- write_file：写入文件内容（覆盖模式）。参数：path (string), content (string)
- run_command：执行 shell 命令。参数：command (string)
- search_code：在代码库中搜索关键字。参数：query (string), path (string, 可选)
- list_files：列出目录下的文件。参数：path (string)`;

// ---------- 工具定义 ----------
const TOOLS = [
  {
    name: "read_file",
    description: "读取文件内容",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "写入文件（覆盖模式）",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "执行 shell 命令",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
      },
      required: ["command"],
    },
  },
  {
    name: "search_code",
    description: "在代码库中搜索（使用 ripgrep）",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        path: { type: "string", description: "搜索路径（可选）" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description: "列出目录中的文件",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径" },
      },
      required: ["path"],
    },
  },
];

// ---------- 工具执行函数 ----------
async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const path = args["path"] as string;
        const content = await readFile(path, "utf-8");
        return content;
      }
      case "write_file": {
        const path = args["path"] as string;
        const content = args["content"] as string;
        await writeFile(path, content, "utf-8");
        return `文件已写入: ${path}`;
      }
      case "run_command": {
        const command = args["command"] as string;
        const result = execSync(command, { encoding: "utf-8", timeout: 30000 });
        return result || "命令执行成功（无输出）";
      }
      case "search_code": {
        const query = args["query"] as string;
        const path = args["path"] ? (args["path"] as string) : ".";
        // 使用 ripgrep
        const result = execSync(`rg --no-heading --line-number '${query.replace(/'/g, "'\\''")}' ${path}`, {
          encoding: "utf-8",
          timeout: 10000,
        });
        return result || "未找到匹配";
      }
      case "list_files": {
        const path = args["path"] as string;
        const entries = await readdir(path, { withFileTypes: true });
        const lines = entries.map((e) =>
          e.isDirectory() ? e.name + "/" : e.name
        );
        return lines.join("\n");
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (error: any) {
    return `工具执行错误: ${error.message}`;
  }
}

// ---------- API 调用 ----------
async function callAPI(
  messages: { role: string; content: any }[],
  systemPrompt: string,
  tools: any[]
): Promise<{
  content: any[];
  stop_reason: string | null;
}> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
      tools: tools,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API 错误 ${response.status}: ${errBody}`);
  }

  const json = await response.json() as {
    content: any[];
    stop_reason: string | null;
  };
  return { content: json.content, stop_reason: json.stop_reason };
}

// ---------- 处理消息中的工具调用 ----------
async function processToolCalls(
  contentBlocks: any[],
  messages: { role: string; content: any }[]
): Promise<boolean> {
  const toolUseBlocks = contentBlocks.filter((b: any) => b.type === "tool_use");
  if (toolUseBlocks.length === 0) return false;

  // 将助手回复添加到历史
  messages.push({ role: "assistant", content: contentBlocks });

  // 执行所有工具
  const toolResults = [];
  for (const block of toolUseBlocks) {
    const result = await executeTool(block.name, block.input);
    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: result,
    });
  }

  // 添加工具结果消息
  messages.push({ role: "user", content: toolResults });
  return true;
}

// ---------- 读取多行输入 ----------
async function readMultilineInput(
  rl: readline.Interface
): Promise<string> {
  let lines: string[] = [];
  let startLine: string | null = null;
  while (true) {
    const line = await rl.question("");
    if (startLine === null) {
      const trimmed = line.trim();
      if (trimmed.startsWith('"""')) {
        startLine = trimmed.slice(3);
        if (startLine.endsWith('"""')) {
          // 单行多行
          return startLine.slice(0, -3);
        }
        continue;
      } else {
        return line;
      }
    } else {
      if (line.trimEnd().endsWith('"""')) {
        lines.push(line.slice(0, -3));
        break;
      }
      lines.push(line);
    }
  }
  return [startLine, ...lines].join("\n");
}

// ---------- 主循环 ----------
async function main() {
  if (!API_KEY) {
    console.error("错误：请设置环境变量 ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  console.log("🧠 简易版 Claude Code");
  console.log(`模型: ${MODEL}`);
  console.log('输入 "exit" 或 "quit" 退出。支持多行输入：以 """ 开头和结尾。');
  console.log();

  const history: { role: string; content: any }[] = [];

  while (true) {
    const userInput = await rl.question(">>> ");
    const trimmed = userInput.trim();
    if (trimmed === "exit" || trimmed === "quit") {
      break;
    }
    if (!trimmed) continue;

    let fullInput = trimmed;
    if (trimmed.startsWith('"""')) {
      fullInput = await readMultilineInput(rl);
    }

    // 添加用户消息
    history.push({ role: "user", content: fullInput });
    // 截断历史
    while (history.length > MAX_HISTORY * 2) {
      history.splice(0, 2);
    }

    // 循环处理工具调用
    let rounds = 0;
    const maxRounds = 10;
    while (rounds < maxRounds) {
      rounds++;
      try {
        const response = await callAPI(history, SYSTEM_PROMPT, TOOLS);
        const contentBlocks = response.content;
        const stopReason = response.stop_reason;

        // 输出非 tool_use 的文本
        const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
        for (const tb of textBlocks) {
          process.stdout.write(tb.text);
        }

        const hasToolCalls = await processToolCalls(
          contentBlocks,
          history
        );

        if (!hasToolCalls) {
          // 非工具调用，助手回复已通过 processToolCalls 添加？不，没有工具调用时不会添加，需手动添加
          if (!textBlocks.some((b: any) => b.type === "text")) {
            // 没有文本，可能只是思考？但通常至少有一个 text 或 tool_use
          }
          // 手动将助手消息加入历史
          history.push({ role: "assistant", content: contentBlocks });
          break;
        }

        if (stopReason === "end_turn" || stopReason === "stop_sequence") {
          break;
        }
      } catch (error: any) {
        console.error("\n调用 API 时出错:", error.message);
        break;
      }
    }
    if (rounds >= maxRounds) {
      console.log("\n⚠️ 达到最大工具调用轮次，返回控制权");
    }
  }

  rl.close();
  console.log("\n再见！");
}

main().catch(console.error);
