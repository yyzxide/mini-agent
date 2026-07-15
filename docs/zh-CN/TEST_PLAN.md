# 测试计划

当前项目只保留本地 CLI Agent，因此测试目标也收缩为：保证 CLI、任务分流、工具系统、AgentLoop、LLM 客户端、patch、命令执行和 session 记录稳定。

截至本轮修复，已验证：

- `tsc -p tsconfig.json --noEmit` 通过。
- `tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` 通过。
- 正常环境全量 Vitest 基线：39 个测试文件、288 个测试用例。
- Windows / Linux 友好性增强：命令测试不再依赖 `printf`、`sh`、`false`、`sleep` 等 Unix-only 命令。

## 1. 自动化测试范围

### 1.1 ToolRegistry 和工具

覆盖：

- 工具注册、获取、列表。
- zod 参数校验失败。
- 工具不存在。
- `list_files` 忽略目录和数量限制。
- `read_file` 行范围、二进制拒绝、路径越权、内部元数据路径拒绝。
- `search_code` 调用 ripgrep、路径规范化、异常 JSON 行容错、内部元数据路径拒绝。
- `fetch_url` 能读取公网文本内容，拒绝 localhost/内网目标，并限制输出。
- `git_status` 和 `git_diff`。
- `apply_patch` 权限、check、apply、失败返回，并验证 patch 行尾不会被全局 Git `core.autocrlf` 配置干扰。
- tool manifest 输出 source、category 和能力标注。
- MCP 风格 tool descriptor 输出 inputSchema、annotations 和 permission metadata。

### 1.1.1 MCP Tools Runtime

覆盖：

- 本地工具能导出 MCP 风格 descriptor。
- `fetch_url`、`web_search` 等外部世界工具带 `openWorldHint`。
- `apply_patch` 等修改型工具带 `destructiveHint`。
- MCP server config schema 校验 command/url、args、enabled。
- stdio fixture 能完成 initialize、tools/list 和 tools/call。
- Streamable HTTP fixture 能处理 JSON response、session header 和 close。
- 远端工具名称隔离、permission mapping、错误包装和 Registry dispose。
- `mini-agent mcp tools/status/call` 能输出结构化结果。

### 1.2 CommandRunner

覆盖：

- 成功命令。
- 失败命令。
- stdout/stderr 捕获。
- 超时。
- 输出截断。
- cwd 设置。
- 跨平台测试不依赖 Unix shell 工具。

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
- `/history`、`/events`、`/resume`、`/pause`、`/review`、`/compact` 等交互式 session 操作。

### 1.4.1 Runtime Log / Change Log

覆盖：

- 运行日志写入 `.mini-agent/logs/YYYY-MM-DD.jsonl`，包含代码审查阶段日志，以及补充相关文件加载记录。
- 日志读取和按数量截断。
- API key、authorization、token、password 等敏感字段脱敏。
- 任务变更日志写入 `.mini-agent/change-log.jsonl`。
- 变更日志记录任务、session、执行模式、成功失败、摘要、当前变更文件、diff stat 和测试结果；代码审查任务还要记录 review file、supplementalFiles、findings、rejectedFindings 和 verdict。
- `mini-agent logs`、`mini-agent changes`、`mini-agent doctor` 能输出结构化 JSON。

### 1.4.2 Long-term Memory / RAG

覆盖：

- 从 `TASK_SUMMARY` 和 `MEMORY_COMPACTION` 生成 `.mini-agent/memory/index.jsonl`。
- 重复索引同一个 session 不产生重复 memory id。
- 支持中英文关键词抽取。
- 支持本地向量式相似度 + 关键词混合检索。
- `MemoryQueryBuilder` 能识别代码任务、联网问题、运行错误和会话记忆问题。
- `MemoryReranker` 能根据任务模式、同 session、时间新鲜度和实体命中调整排序。
- `MemoryEvidenceSelector` 能限制单 session 结果过度集中，并标记证据选择原因。
- `ContextBuilder` 会把相关长期记忆注入 `Long-term retrieved memory`。
- `mini-agent memory index`、`mini-agent memory search`、`mini-agent memory list` 能输出结构化 JSON。
- 交互式 `/memory <query>` 能检索当前仓库的长期记忆。
- Direct/Web/Review/RepositoryAnalysis/AgentLoop 可按策略召回长期记忆，并把它标记为不可信历史证据；实时 Web 问题和易过期赛果必须禁用长期记忆召回。
- `remember -> search -> forget/clear` 生命周期、失败任务过滤和常见密钥脱敏。
- 结构化 compaction 同时保留关键用户/助手事实和最近上下文。

### 1.4.3 Skill

覆盖：

- 仓库 `skills/` 与本地 `.mini-agent/skills/` 发现、CRLF 解析和同名优先级。
- metadata 缺失、非法名称、超长或逃逸路径不会进入有效 Skill 列表。
- `$skill-name` 显式选择、trigger 自动匹配、稳定排序和数量上限。
- Skill 上下文明确“当前用户指令和仓库事实优先”，且覆盖所有回答/任务模式。

### 1.5 LLM

覆盖：

- OpenAI-compatible 请求格式。
- API key header。
- baseUrl 拼接。
- 超时配置。
- 模型返回 decision 解析。
- 常见 decision 形状漂移的容错，例如小写 type、`message`/`summary` 字段混用、`APPLY_PATCH` 漏写 description。
- 配置缺失时给出清晰错误。

测试中可以 stub `fetch`，避免依赖真实网络。

### 1.6 TaskRouter 和回答模式

覆盖：

- 普通聊天和解释类问题进入 `DIRECT_ANSWER`。
- 明确声明“代码片段 / 不要改文件”的请求进入 `DIRECT_ANSWER`。
- 默认的代码生成请求进入 `AGENT_LOOP`，并真正创建或修改仓库文件。
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
- 写文件类任务如果没有成功 patch，不能直接 final 成功。
- 已经有代码上下文的“写进去 / 保存到文件”追问，不能反问用户重复提供代码或文件路径。
- 最大步数终止。
- session/event 写入。
- Plan 模式只向模型暴露只读工具。
- Plan 模式硬拦 `APPLY_PATCH`、`RUN_COMMAND` 和伪装成 `TOOL_CALL apply_patch` 的写操作。
- 写代码目标可以在 Plan 模式正常 FINAL，而不会触发执行态的“必须已有 patch”后置条件。
- Plan 完成不生成 diff，Session 中记录 `TASK_SUMMARY.mode=PLAN`。

### 1.8.1 Agent Harness / Eval

覆盖：

- scripted LLM 能按预设 `AgentDecision` 驱动 AgentLoop。
- Harness 能创建临时 git 仓库、写入初始文件、执行 patch、读取 diff。
- Harness 能校验成功状态、diff 内容和文件内容。
- Harness 能统计步骤、LLM 调用、工具选择、工具选择准确率和失败类别。
- stdio 与 Streamable HTTP MCP fixture 能完成 initialize、tools/list 和 tools/call。
- 普通 Web 问题没有可读正文时进入证据不足回答；实时问题必须至少抓取两个独立域名的正文，否则不得输出确定性结果。
- Web 答案中出现本轮来源列表之外的 URL 时必须触发重写；重写仍引用未知 URL 时由本地拦截。
- 长期记忆会排除过期和已被替代的条目，并支持可替换 embedding provider。
- 后续真实场景可以沉淀成 scenario，不再完全依赖人工 CLI 试用。

### 1.9 Diagnostics

覆盖：

- `npm/pnpm/yarn` 找不到 `package.json` 时识别为运行目录错误。
- `command not found` 识别为命令不存在或 PATH 问题。
- `Port ... already in use` / `EADDRINUSE` 识别为端口占用。
- `ECONNREFUSED host:port` 识别为依赖服务未启动或地址错误。
- `EACCES` / `Permission denied` 识别为权限不足。
- 普通聊天文本不能误判为错误诊断。

### 1.10 对话级回归集

新增一套独立的 CLI regression suite，目标不是单纯增加覆盖率，而是固定住已经踩过的真实问题。当前至少覆盖：

- 明确要求“代码片段 / 不要改文件”的请求，不能误入 `AGENT_LOOP`
- “帮我写个 最长有效括号”这类实现型请求，应该真正落到文件
- 先返回代码片段，再追问“写入一个文件里面”或“写进去”时，必须自动承接上一轮代码块并创建文件
- 上一轮是代码落盘任务时，继续问“数据流的中位数呢”这类短算法追问，必须继续走 `AGENT_LOOP`
- 用户问“你写入了嘛？”时，必须读取 session 中的 `FILE_CHANGE` 记录作答，不能让模型猜测
- 用户贴出 `npm error enoent Could not read package.json`，且报错路径不在当前仓库时，必须诊断为运行目录错误，而不是说代码本身能跑
- `葡萄牙呢` 这种短追问，必须结合上一轮会话补全为明确问题
- 先测试 Skill、再创建五子棋，随后问“这个难度如何”时，请求上下文只能保留最近的五子棋任务，不能重新引用 Skill 或注入历史 Skill 记忆
- `long time no see` 必须走普通问答，不能进入 AgentLoop 或输出 `[diff]`
- “昨天法国队踢西班牙队，谁赢了”与“法国队vs西班牙队，谁赢了”必须直接进入 `WEB_ANSWER`
- 普通回答拒绝联网后再说“你用搜一下啊”，必须复用上一轮赛事问题，而不是搜索这句追问本身
- `/new` 后的实时赛果不得从旧 session 长期记忆中作答
- 名称、模型标识、处理路径和 `WEB_ANSWER` 能力说明必须由本地产品知识回答，不能虚构手动切换方式
- AgentLoop 的 tool/patch/command decision 不能作为 `ASSISTANT_MESSAGE` 进入后续聊天历史；旧 session 中紧随 `AGENT_DECISION` 的遗留消息也必须过滤
- “分析当前文件夹的项目”必须先读取真实仓库证据，再总结
- 模型声称“已写入”但没有 patch 时，必须被质量闸门拦截并继续修复
- 模型在已经有代码上下文时反问“写入什么内容到哪个文件”，必须被质量闸门拦截

执行命令：

```bash
npm run test:regression
```

演示前快速验收：

```bash
npm run verify:regression
```

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
> /pause
> /resume <sessionId>
> /exit
```

观察：

- `/new` 后 session id 改变。
- `/pause` 后当前 session 状态变为 `PAUSED`，并提示 resume 命令。
- `/resume` 后当前 session 切到指定 id。
- resume 后 session 状态切回 `ACTIVE`。
- `/review` 能直接触发文件级代码审查。
- `/summary` 能输出当前 session 的压缩摘要。
- `/history` 能看到当前 session 的用户消息、助手消息、工具结果、任务总结。
- `/compact` 会写入 `MEMORY_COMPACTION` 记录。

## 3. 提交前命令

```bash
npm run build
npm run typecheck
npm run lint:unused
npm run test:regression
npm test
npm run verify
git diff --check
```

## 4. 风险点

| 风险 | 检查方式 |
| --- | --- |
| 模型输出非 JSON | LLM/DecisionParser 测试 |
| 工具参数错误 | ToolRegistry 测试 |
| 路径越权 | fs/read_file/search_code/apply_patch 测试 |
| 内部元数据泄露 | read_file/search_code 的 `.git`、`.mini-agent` 拒绝测试 |
| 命令卡死 | CommandRunner 超时测试 |
| URL 读取失控 | fetch_url 超时、大小、内网目标测试 |
| patch 损坏 | PatchManager check 测试 |
| Git 换行配置影响 patch | PatchManager `core.autocrlf=false` 回归测试 |
| session 丢失 | SessionStore/EventStore 测试 |
| 长期记忆误检索 | LongTermMemoryStore 和 ContextBuilder 测试 |
| MCP/tool 元数据漂移 | ToolRegistry 和 McpToolBridge 测试 |
| 多步 Agent 场景不可回归 | AgentHarness 测试 |
| 真实 API 不可用 | 配置错误提示和 fetch stub 测试 |

## 5. 当前不测

因为项目已经删除后端和前端，所以不再测试：

- Java 服务启动。
- Swagger。
- React 页面。
- 浏览器交互。
- Docker 控制面。

这些属于独立业务项目或未来外部集成，不是当前 CLI 仓库范围。
