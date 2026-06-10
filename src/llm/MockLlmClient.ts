import type { AgentDecision } from "../agent/AgentDecision.js";
import type { AgentToolExecutionResult } from "../agent/AgentState.js";
import type { JsonObject } from "../session/SessionTypes.js";
import type { LlmClient, LlmInput } from "./LlmClient.js";

interface ReadFileData {
  path: string;
  totalLines: number;
  content: string;
}

interface SearchCodeData {
  results: Array<{ path: string }>;
}

export class MockLlmClient implements LlmClient {
  async chat(input: LlmInput): Promise<AgentDecision> {
    const goal = input.userGoal.toLowerCase();

    if (goal.includes("demo") || goal.includes("hello")) {
      return demoDecision(input);
    }

    if (goal.includes("upload")) {
      return uploadDecision(input);
    }

    return defaultDecision(input);
  }
}

function demoDecision(input: LlmInput): AgentDecision {
  switch (input.state.step) {
    case 0:
      return {
        type: "PLAN",
        message: "我会先搜索 demo 相关内容，读取 demo.txt，然后生成 patch、运行验证命令并查看 diff。",
      };
    case 1:
      return { type: "TOOL_CALL", toolName: "search_code", input: { query: "demo", path: ".", maxResults: 20 } };
    case 2:
      return { type: "TOOL_CALL", toolName: "read_file", input: { path: "demo.txt", maxLines: 300 } };
    case 3:
      return {
        type: "APPLY_PATCH",
        description: "给 demo.txt 增加 hello from mini-agent",
        patch: buildDemoPatch(input.state.toolResults),
      };
    case 4:
      return { type: "RUN_COMMAND", command: "echo test passed", description: "运行演示验证命令" };
    case 5:
      return { type: "TOOL_CALL", toolName: "git_diff", input: {} };
    default:
      return {
        type: "FINAL",
        success: true,
        summary: "已完成 demo.txt 修改，并运行 echo test passed 验证，diff 已生成。",
      };
  }
}

function uploadDecision(input: LlmInput): AgentDecision {
  if (input.state.step === 0) {
    return { type: "PLAN", message: "我会先搜索 upload 相关代码，再根据搜索结果决定下一步。" };
  }

  if (input.state.step === 1) {
    return { type: "TOOL_CALL", toolName: "search_code", input: { query: "upload", path: ".", maxResults: 20 } };
  }

  const searchResult = findToolResult<SearchCodeData>(input.state.toolResults, "search_code");
  const firstPath = searchResult?.results[0]?.path;
  if (input.state.step === 2 && firstPath) {
    return { type: "TOOL_CALL", toolName: "read_file", input: { path: firstPath, maxLines: 200 } };
  }

  return {
    type: "FINAL",
    success: true,
    summary: firstPath
      ? `已搜索 upload 相关代码并读取 ${firstPath}，Mock 流程到此结束。`
      : "未找到 upload 相关代码，Mock 流程没有生成修改。",
  };
}

function defaultDecision(input: LlmInput): AgentDecision {
  switch (input.state.step) {
    case 0:
      return { type: "PLAN", message: "我会先查看仓库状态、目录摘要和当前 diff。" };
    case 1:
      return { type: "TOOL_CALL", toolName: "git_status", input: {} };
    case 2:
      return { type: "TOOL_CALL", toolName: "list_files", input: { path: ".", maxDepth: 2 } };
    case 3:
      return { type: "TOOL_CALL", toolName: "git_diff", input: {} };
    default:
      return { type: "FINAL", success: true, summary: "已完成通用仓库巡检流程。" };
  }
}

function buildDemoPatch(toolResults: AgentToolExecutionResult[]): string {
  const readResult = [...toolResults].reverse().find((result) => result.toolName === "read_file");
  const readData = readResult?.result.success ? asReadFileData(readResult.result.data) : undefined;

  if (!readData || readData.content.length === 0 && readData.totalLines === 0) {
    return [
      "diff --git a/demo.txt b/demo.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/demo.txt",
      "@@ -0,0 +1 @@",
      "+hello from mini-agent",
      "",
    ].join("\n");
  }

  if (readData.content.split(/\r?\n/).includes("hello from mini-agent")) {
    return [
      "diff --git a/demo.txt b/demo.txt",
      "--- a/demo.txt",
      "+++ b/demo.txt",
      "@@ -1 +1 @@",
      ` ${readData.content.split(/\r?\n/)[0] ?? ""}`,
      "",
    ].join("\n");
  }

  const lines = readData.content.split(/\r?\n/);
  const oldCount = Math.max(1, readData.totalLines || lines.length);
  const newCount = oldCount + 1;
  const header = oldCount === 1 ? "@@ -1 +1,2 @@" : `@@ -1,${oldCount} +1,${newCount} @@`;

  return [
    "diff --git a/demo.txt b/demo.txt",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    header,
    ...lines.map((line) => ` ${line}`),
    "+hello from mini-agent",
    "",
  ].join("\n");
}

function findToolResult<TData>(toolResults: AgentToolExecutionResult[], toolName: string): TData | undefined {
  const found = [...toolResults].reverse().find((result) => result.toolName === toolName && result.result.success);
  return found ? found.result.data as TData : undefined;
}

function asReadFileData(value: unknown): ReadFileData | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const path = value.path;
  const totalLines = value.totalLines;
  const content = value.content;

  if (typeof path === "string" && typeof totalLines === "number" && typeof content === "string") {
    return { path, totalLines, content };
  }

  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
