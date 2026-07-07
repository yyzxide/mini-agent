# 测试计划

当前项目只保留本地 CLI Agent，因此测试目标也收缩为：保证 CLI、任务分流、工具系统、AgentLoop、LLM 客户端、patch、命令执行和 session 记录稳定。

## 1. 自动化测试范围

### 1.1 ToolRegistry 和工具

覆盖：

- 工具注册、获取、列表。
- zod 参数校验失败。
- 工具不存在。
- `list_files` 忽略目录和数量限制。
- `read_file` 行范围、二进制拒绝、路径越权。
- `search_code` 调用 ripgrep。
- `fetch_url` 能读取公网文本内容，拒绝 localhost/内网目标，并限制输出。
- `git_status` 和 `git_diff`。
- `apply_patch` 权限、check、apply、失败返回。

### 1.2 CommandRunner

覆盖：

- 成功命令。
- 失败命令。
- stdout/stderr 捕获。
- 超时。
- 输出截断。
- cwd 设置。

### 1.3 PermissionManager

覆盖：

- `SAFE` 自动允许。
- `REVIEW` 和 `DANGEROUS` 的交互式确认。
- 非交互模式拒绝。
- autoApprove。
- 危险命令拦截。

### 1.4 Session/Event

覆盖：

- 初始化 `.mini-agent`。
- 创建 session。
- 追加 JSONL。
- 读取 session。
- 写入工具、命令、patch、diff、任务完成事件。
- `/history`、`/events`、`/resume`、`/review`、`/compact` 等交互式 session 操作。

### 1.4.1 Runtime Log / Change Log

覆盖：

- 运行日志写入 `.mini-agent/logs/YYYY-MM-DD.jsonl`，包含代码审查阶段日志，以及补充相关文件加载记录。
- 日志读取和按数量截断。
- API key、authorization、token、password 等敏感字段脱敏。
- 任务变更日志写入 `.mini-agent/change-log.jsonl`。
- 变更日志记录任务、session、执行模式、成功失败、摘要、当前变更文件、diff stat 和测试结果；代码审查任务还要记录 review file、supplementalFiles、findings、rejectedFindings 和 verdict。
- `mini-agent logs`、`mini-agent changes`、`mini-agent doctor` 能输出结构化 JSON。

### 1.5 LLM

覆盖：

- OpenAI-compatible 请求格式。
- API key header。
- baseUrl 拼接。
- 超时配置。
- 模型返回 decision 解析。
- 配置缺失时给出清晰错误。

测试中可以 stub `fetch`，避免依赖真实网络。

### 1.6 TaskRouter 和回答模式

覆盖：

- 普通聊天和解释类问题进入 `DIRECT_ANSWER`。
- 独立代码片段请求进入 `DIRECT_ANSWER`。
- 需要最新外部资料的问题进入 `WEB_ANSWER`。
- 仓库阅读、修改、测试、修复任务进入 `AGENT_LOOP`。
- 英文关键词按词边界匹配，避免 `latest` 被误判成 `test`。

### 1.7 WebQuestionPlanner

覆盖：

- 根据 session memory 把追问改写成独立搜索问题。
- 普通时效问题生成多条搜索 query。
- 实时比分、赛事结果等问题追加官方站和比分源 query。
- 版本发布类问题追加官方 release notes、changelog、GitHub releases。
- 模型规划返回非法 JSON 时回退到本地启发式策略。
- 最终回答上下文包含 `answerScope`、`sourceHints` 和 `answerInstructions`。

### 1.8 AgentLoop

覆盖：

- tool_call -> tool result -> final。
- apply_patch -> git diff -> final。
- run_command 成功。
- run_command 失败后进入下一轮。
- 最大步数终止。
- session/event 写入。

## 2. 手工测试范围

### 2.1 CLI help

```bash
mini-agent --help
mini-agent run --help
mini-agent tool --help
mini-agent command --help
mini-agent patch --help
mini-agent config --help
mini-agent doctor
mini-agent logs
mini-agent changes
```

### 2.2 工具调试

```bash
mini-agent tool list
mini-agent tool run list_files '{"path":"."}'
mini-agent tool run read_file '{"path":"README.md"}'
mini-agent tool run search_code '{"query":"AgentLoop","path":"src"}'
mini-agent tool run web_search '{"query":"TypeScript latest release","maxResults":3}'
mini-agent tool run fetch_url '{"url":"https://example.com"}'
mini-agent tool run git_status '{}'
mini-agent tool run git_diff '{}'
```

### 2.3 命令执行

```bash
mini-agent command run "echo hello"
mini-agent command run "npm test"
mini-agent command run "sudo reboot"
```

第三条应该被拦截。

### 2.4 真实模型任务

```bash
mini-agent run "总结这个仓库的 src/agent、src/tools、src/session 分别做什么"
mini-agent run "联网搜索一下 TypeScript 最新版本信息"
```

观察：

- 仓库任务是否调用代码工具并输出最终 `[summary]`。
- 联网任务是否调用 `web_search` / `fetch_url` 并输出 `[answer]`。
- 当前来源抓取失败时，是否继续尝试后续候选来源。
- 是否写 session/event。
- 是否写 runtime log/change log，可用 `mini-agent logs` 和 `mini-agent changes` 查看。

### 2.5 修改类任务

在可丢弃分支或临时仓库里测试：

```bash
mini-agent run "给 README 增加一段说明，解释本项目为什么是纯 CLI Agent"
git diff
```

观察：

- patch 是否能应用。
- diff 是否符合预期。
- session 是否记录 patch 事件。
- change-log 是否记录本次任务摘要、变更文件和 diff stat。

### 2.6 交互式 session 命令

```text
mini-agent
> /help
> /review src/tools/WebSearchTool.ts
> /session
> /history 10
> /events 10
> /summary
> /logs 10
> /changes 10
> /compact
> /new
> /sessions
> /resume <sessionId>
> /exit
```

观察：

- `/new` 后 session id 改变。
- `/resume` 后当前 session 切到指定 id。
- `/review` 能直接触发文件级代码审查。
- `/summary` 能输出当前 session 的压缩摘要。
- `/history` 能看到当前 session 的用户消息、助手消息、工具结果、任务总结。
- `/compact` 会写入 `MEMORY_COMPACTION` 记录。

## 3. 提交前命令

```bash
npm run build
npm test
npm run verify
git diff --check
```

## 4. 风险点

| 风险 | 检查方式 |
| --- | --- |
| 模型输出非 JSON | LLM/DecisionParser 测试 |
| 工具参数错误 | ToolRegistry 测试 |
| 路径越权 | fs/read_file/apply_patch 测试 |
| 命令卡死 | CommandRunner 超时测试 |
| URL 读取失控 | fetch_url 超时、大小、内网目标测试 |
| patch 损坏 | PatchManager check 测试 |
| session 丢失 | SessionStore/EventStore 测试 |
| 真实 API 不可用 | 配置错误提示和 fetch stub 测试 |

## 5. 当前不测

因为项目已经删除后端和前端，所以不再测试：

- Java 服务启动。
- Swagger。
- React 页面。
- 浏览器交互。
- Docker 控制面。

这些属于独立业务项目或未来外部集成，不是当前 CLI 仓库范围。
