# 架构设计说明

## 1. 当前定位

`mini-coding-agent` 是一个本地 CLI 形态的 AI Coding Agent。用户在某个 git 仓库中运行 CLI，输入自然语言任务，Agent 通过一组受控工具完成代码搜索、文件读取、联网搜索资料、联网读取公开文档、补丁应用、命令执行、测试反馈和 diff 总结。

它的主业是代码任务，但不应该丢失正常 AI 助手的基础能力。普通非代码问题会走直接回答；需要外部时效信息的问题会进入 AgentLoop，通过受控联网工具搜索和读取资料。

当前版本不内置后端服务和前端页面。所有核心能力都在 TypeScript CLI Runner 中完成。

## 2. 总体链路

```text
CLI
 -> TaskRouter
 -> AgentLoop
 -> ContextBuilder
 -> OpenAICompatibleClient
 -> AgentDecision
 -> ToolRegistry / PatchManager / CommandRunner
 -> SessionStore / EventStore
 -> final summary + git diff
```

核心循环：

1. 初始化 `AgentState`。
2. 构建仓库上下文和当前 session 的短期记忆。
3. 先用 `TaskRouter` 判断是直接回答，还是进入仓库 AgentLoop。
4. 直接回答任务只调用文本 LLM，不改文件。
5. 仓库任务调用真实 LLM，解析出 `AgentDecision`。
6. 根据 decision 执行工具、应用 patch、运行命令或结束。
7. 命令失败时把日志放回上下文。
8. 达到 final 或最大步数后输出总结和 diff。

## 3. 目录职责

```text
src/cli              CLI 入口和调试命令
src/agent            TaskRouter、AgentLoop、状态、决策类型
src/context          仓库扫描、仓库状态分析和上下文拼接
src/tools            统一工具接口和工具实现
src/patch            patch 预览、check、apply
src/command          命令执行、超时、输出截断
src/git              git status/diff/commit 辅助能力
src/permission       权限级别和危险命令拦截
src/session          JSONL session/event 存储
src/llm              LLM 接口和 OpenAI-compatible 客户端
src/config           本地配置文件读取和脱敏
src/utils            路径安全、错误处理、日志
tests                自动化测试
```

## 4. AgentDecision

`TaskRouter` 在进入 AgentLoop 之前先做轻量分流：

- 普通问答和独立代码片段走 `DIRECT_ANSWER`，只输出答案，不改仓库。
- 明确提到仓库、文件、修改、测试、修复等任务走 `AGENT_LOOP`。
- “刚才聊了什么 / 还记得吗 / 上次呢”这类会话追问走 `DIRECT_ANSWER`，但会带上当前 session 的最近记录。
- `--agent-loop` 可以强制进入仓库修改流程。

Agent 每轮从模型获得一个结构化决策：

- `tool_call`：调用只读或安全工具。
- `apply_patch`：应用 unified diff。
- `run_command`：执行命令，例如测试。
- `ask_user`：需要用户补充信息。
- `final`：任务完成，输出总结。
- `failed`：模型调用或决策解析失败。

这种设计把“模型想做什么”和“程序怎么执行”分开，方便做权限控制、日志记录和测试。

## 5. 工具系统

每个工具实现统一接口：

```ts
interface Tool<TInput, TResult> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  permissionLevel: PermissionLevel;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TResult>>;
}
```

`ToolRegistry` 负责：

- 注册工具。
- 按名称查找工具。
- 用 zod 校验输入。
- 包装执行异常。
- 返回结构化 `ToolResult`。
- 导出工具 spec 给 LLM prompt。

目前工具：

- `list_files`
- `read_file`
- `search_code`
- `git_status`
- `git_diff`
- `web_search`
- `fetch_url`
- `apply_patch`

## 6. 路径安全

文件类工具不直接拼字符串访问路径，而是统一调用 `resolveRepoPath(repoPath, targetPath)`。

安全策略：

- 支持相对路径。
- 拒绝访问仓库外路径。
- 拒绝绝对路径逃逸。
- 拒绝 `.git` 和 `.mini-agent` 等内部路径的危险写入。
- 错误返回清晰 message，例如 `Path is outside repository`。

这保证 Agent 即便收到不可靠的模型输出，也不能随意读写仓库外文件。

## 7. 联网工具

联网能力通过 `web_search` 和 `fetch_url` 两层提供，而不是让 Agent 任意访问网络。

`web_search` 用于搜索公开网页结果，返回标题、URL 和摘要。它适合回答“最新资料”“网上查一下”“新闻/来源”等问题。

`fetch_url` 用于读取指定公开 URL。它的边界是：

- 只支持 `http` 和 `https`。
- 拒绝 localhost、`.local` 和明显的内网 IP。
- 限制超时时间和最大下载字节数。
- 只返回文本、HTML、JSON、XML 等可读内容。
- HTML 会做简单文本抽取，避免把脚本和样式塞进上下文。

当前 `web_search` 默认使用 DuckDuckGo HTML 结果页做轻量解析。后续如果需要更稳定的生产效果，可以接 Brave、Tavily、SerpAPI 或企业内部搜索 API。

## 7.5 仓库状态分析

`git status`、`git diff`、`git log` 只属于事实层，不能直接等价于 Agent 对仓库的理解。当前版本增加了 `RepoStateAnalyzer`，用于把多种信号合成更适合模型和用户阅读的状态摘要：

- git 分支、commit、变更文件和 diff 统计。
- 项目构建文件，例如 `package.json`、`pom.xml`、`go.mod`。
- 主要语言分布。
- package scripts。
- 建议验证命令，例如 `npm test`、`pnpm test`、`mvn test`、`go test ./...`。

交互式 `/status` 和 `mini-agent status` 使用这层摘要；`mini-agent git status` 仍保留为底层 git 调试命令。

## 8. Patch 设计

patch 由 `PatchManager` 管理：

1. 预览 patch。
2. 检查 patch 是否越权或修改内部目录。
3. 执行 `git apply --check`。
4. 执行 `git apply`。
5. 获取最终 `git diff`。
6. 把 patch 事件写入 session/event。

这样可以把“模型生成修改”和“本地实际落盘”之间加一层工程校验。

## 9. 命令执行

`CommandRunner` 使用子进程执行命令，返回结构化结果：

```json
{
  "command": "npm test",
  "exitCode": 1,
  "stdout": "...",
  "stderr": "...",
  "durationMs": 1234,
  "success": false,
  "timedOut": false,
  "truncated": false
}
```

命令执行有几个限制：

- 默认超时。
- 最大输出长度。
- 危险命令拦截。
- 工作目录限制。
- 失败结果进入下一轮上下文。

## 10. Session 和 Event

`.mini-agent/` 是本地记录目录：

```text
.mini-agent/
  config.json
  sessions/<sessionId>.jsonl
  events/<sessionId>.jsonl
```

Session 更像最终状态记录，Event 更像时间线。二者都用 JSONL，是因为：

- 易追加。
- 易人工查看。
- 不依赖数据库。
- 崩溃时仍保留已写入步骤。
- 以后可以被别的系统读取。

交互式 CLI 启动时会创建一个活跃 session；用户连续输入多轮任务时复用同一个 session，只有 `/new` 才会创建新 session，`/exit` 会结束当前 session。`mini-agent resume <sessionId>` 会重新打开指定 session，并继续把该 session 的最近记录作为上下文。

`SessionMemory` 会把最近的用户消息、助手消息、任务总结、工具结果、命令结果和错误压缩成一段短期记忆。`ContextBuilder` 在 AgentLoop 每轮调用 LLM 前注入这段记忆；直接回答模式也会把这段记忆放进文本回答请求中。因此它能回答“刚才我们聊了什么”这类当前会话追问。

当前这层记忆是 transcript memory，不是完整 RAG。它解决同一会话连续性；如果要跨仓库、跨天、跨长文档检索，需要后续再加索引、摘要和向量/关键词检索。

## 11. LLM 接入

当前产品运行路径使用真实 OpenAI-compatible API：

- `MINI_AGENT_BASE_URL`
- `MINI_AGENT_API_KEY`
- `MINI_AGENT_MODEL`

也支持根目录 `mini-agent.config.json`：

```json
{
  "version": 1,
  "llm": {
    "mode": "real",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your-api-key",
    "model": "your-model"
  }
}
```

配置读取和 LLM 客户端保持独立，避免 AgentLoop 直接依赖某个厂商 SDK。

## 12. 为什么现在不做后端和前端

这个项目的核心价值是本地 CLI Agent 的闭环，而不是展示页面。后端和前端适合做成独立项目，例如软件商店后台、任务平台或企业控制台。

当前仓库保留最小但完整的 Agent 本体，优点是：

- 运行链路更短。
- 面试讲解更聚焦。
- 调试成本更低。
- 不会把重点从 Agent 工程能力转移到普通 CRUD 页面。
