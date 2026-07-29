# 测试计划

当前项目只保留本地 CLI Agent，因此测试目标是保证 CLI、统一语义与契约、工具系统、AgentLoop、LLM 客户端、Patch、命令、上下文、多 Agent 和 Session 审计稳定。

当前验证基线：

- `pnpm check:architecture` 会拒绝不可达源码、无法解析的本地 import、已删除控制面文件复活，以及旧执行模式标识越过持久化兼容边界。
- `tsc -p tsconfig.json --noEmit` 通过。
- `tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` 通过。
- `corepack pnpm test` 全量 Vitest 通过；具体数量以当次命令输出为准，不在长期文档中写死。
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

- 运行日志写入 `.mini-agent/logs/YYYY-MM-DD.jsonl`，记录统一 AgentLoop 的结构化事件与诊断。
- 日志读取和按数量截断。
- API key、authorization、token、password 等敏感字段脱敏。
- 任务变更日志写入 `.mini-agent/change-log.jsonl`。
- 新变更日志只写 `AGENT_LOOP / PLAN`，记录任务、session、成功失败、摘要、任务级变更文件、diff stat、测试结果和通用执行 metadata；读取边界仍兼容旧模式与旧 review metadata。
- `mini-agent logs`、`mini-agent changes`、`mini-agent doctor` 能输出结构化 JSON。

### 1.4.2 Long-term Memory

覆盖：

- 从 `TASK_SUMMARY` 和 `MEMORY_COMPACTION` 生成 `.mini-agent/memory/index.jsonl`。
- 重复索引同一个 session 不产生重复 memory id。
- 支持中英文关键词抽取。
- 支持本地向量式相似度 + 关键词混合检索。
- `MemoryQueryBuilder` 只规范化 TaskFrame 选择的语义查询并提取通用关键词、实体和最近上下文，不再维护代码/Web/错误等第二套任务分类器。
- `MemoryReranker` 根据混合召回分数、同 session、时间新鲜度、实体和来源调整排序，不使用旧任务模式标签。
- `MemoryEvidenceSelector` 能限制单 session 结果过度集中，并标记证据选择原因。
- `ContextBuilder` 会把相关长期记忆注入 `Long-term retrieved memory`。
- `mini-agent memory index`、`mini-agent memory search`、`mini-agent memory list` 能输出结构化 JSON。
- 交互式 `/memory <query>` 能检索当前仓库的长期记忆。
- 普通回答不主动召回长期记忆；TaskFrame 标记的仓库任务只选择稳定偏好、项目约定和架构决策，`target=SESSION` 或结构化历史取证才允许检索已验证结果，`webEvidence=true` 禁用历史事实召回。
- `remember -> search -> forget/clear` 生命周期、失败任务过滤和常见密钥脱敏。
- `structured-salience-v2` compaction 同时受字符与 Token 预算控制，分层保留用户硬约束、最近对话和执行证据。
- 超长工具结果会单条裁剪，重复记录会去重；压缩正文保留来源 id，trace 能解释每条选择的分层、原因和裁剪状态。
- 自动 Session Memory 压缩与显式 `/compact` 共用同一压缩核心。

### 1.4.3 Document Knowledge-base RAG

覆盖：

- Markdown/TXT 安全加载、按行分块、来源哈希和增量重建。
- `.mini-agent/rag/index.jsonl` 与 `.mini-agent/memory/index.jsonl` 相互独立。
- 关键词与向量混合检索、来源/标签过滤、Top-K、多来源和上下文预算。
- `knowledge_search` 返回文件行号 citation，空索引、provider 不匹配和证据不足时拒答。
- 自然语言知识库问题进入可调用 `knowledge_search` 的 Agent 路径；RAG 能力问题返回确定性的本地产品说明。
- embedding 缓存的内存命中、跨实例磁盘命中、provider 隔离、损坏回源和并发 single-flight。

### 1.4.4 Skill

覆盖：

- 仓库 `skills/` 与本地 `.mini-agent/skills/` 发现、CRLF 解析和同名优先级。
- metadata 缺失、非法名称、超长或逃逸路径不会进入有效 Skill 列表。
- `$skill-name` 显式选择、trigger 自动匹配、稳定排序和数量上限。
- Skill 上下文明确“当前用户指令和仓库事实优先”，且覆盖所有 TaskFrame 任务。

### 1.5 LLM

覆盖：

- OpenAI-compatible 请求格式。
- 专用 `compileTaskFrame` 语义编译请求与 AgentDecision `chat` 请求相互分工，不存在 Direct/Web 文本完成模式。
- API key header。
- baseUrl 拼接。
- 超时配置。
- 模型返回 decision 解析。
- 常见 decision 形状漂移的容错，例如小写 type、`message`/`summary` 字段混用、`APPLY_PATCH` 漏写 description。
- 配置缺失时给出清晰错误。

测试中可以 stub `fetch`，避免依赖真实网络。

### 1.6 TaskFrame、TaskContract 和单一控制链

覆盖：

- CLI 和 AgentHarness 请求受 Schema 约束的 `TaskFrame`；程序化 `AgentLoop` 可传入已验证 Task Contract，也可走相同编译链。没有公开控制面开关。
- 旧配置中的 `controlPlane` 字段只会被丢弃，不能启用另一条路由或运行时。
- `TaskFrame` 包含 objective、target、answer、effects、`webEvidencePolicy`、constraints、collaboration、conversation evidence、completion criteria、confidence 和 rationale。
- TaskFrame 的模型资源偏好越界时在本地做边界归一化；结构错误先执行一次有界模型自修。仍失败时 AgentLoop 必须在任何 AgentDecision 或 Tool 前返回 `TASK_FRAME_UNRESOLVED`，不能回退到自然语言正则路由或猜测合同。
- bootstrap 和编译后的合同都保持 `AGENT_TASK`；Web、知识库、仓库读写、命令和委派是可组合效果。
- `CapabilityNegotiator` 可以在一次 `AGENT_TASK` 中依次授权 Web、读取、Patch、Command 和精确 MCP Tool。
- TaskFrame 的显式只读、禁网、禁命令、禁委派和禁 MCP 约束必须拒绝相应动作。
- 模型只选择 `webEvidencePolicy.profile/basis/ranking`；普通、多源、当前和高风险等级由本地策略表映射为搜索、抓取、域名、引用、时效与权威来源门槛，`ranking` 决定搜索查询是否允许排名词。
- 模型附带的旧版或任意数值字段不能放大普通任务的证据门槛；Guardrail 不得重新用原始问句正则决定证据等级。
- 多 Agent 的 requirement、writer proposal、review 和 requestedAgents 由 `TaskFrame.collaboration` 表达。
- 当 `conversationEvidence.requiresHistory` 为真时，模型语义查询从完整 Session 有界选择旧消息和相邻上下文；仓库 Context 不按原句关键词预加载。
- Conversation 从 `AGENT_CHECKPOINT` / `FILE_CHANGE` 携带上一轮只读执行账本；旧助手文字与真实修改证据冲突时必须以后者为准。
- MCP metadata 作为不可信数据进入 TaskFrame；每次只授权模型选择的精确 `<server>__<tool>`。
- 端到端覆盖 TaskFrame -> `web_search` -> `fetch_url` -> `read_file` -> `APPLY_PATCH` -> `RUN_COMMAND` -> `FINAL`。
- 仓库内绝对路径的 `read_file` 必须成功；超大 `maxLines` / `maxTokens` 自动收敛，负数、错误类型和越界路径返回具体错误。

### 1.6.1 多 Agent 与完成性

- `AnswerQualityPolicy` 消费 TaskFrame 的答案形态和深度。
- `NONE / CONDITIONAL / REQUIRED` 修改语义由 TaskFrame 表达；无缺陷的条件任务可以只读完成，有 Patch 时必须验证。
- 已存在或仅被读取的文件不能满足新的创建/写入请求；没有本轮成功 Patch 时，`FINAL` 不得声称文件由本轮创建或修改。
- 子任务协议覆盖 `READ_ONLY`、`PROPOSE_CHANGES` 和依赖前序 Writer 的 `REVIEW_CHANGES`；Writer 在临时 worktree 修改和验证，但不能直接改变主工作区。
- 主 Agent 只有在收到完成的 patch proposal 后才能执行 `APPLY_DELEGATED_PATCH`，并且合入后仍必须满足父级验证门禁。
- 子 Agent 的任务开始、worktree、读工具、Patch、受限验证命令、任务完成、变更文件和依赖关系会进入统一终端事件流。
- 子 Agent 每次 LLM 决策前显示 `thinking step`，之后显示结构化 decision 摘要；协议错误、恢复动作和最终失败原因不得被空状态覆盖。
- 新建独立文件的 writer 可以不读取无关仓库文件直接提交经校验的补丁；修改或删除已有文件仍必须先取得读取证据。
- 常见子级 JSON/Schema 协议错误进行有界恢复；恢复耗尽后保留精确错误。
- 明确要求子代理实现时，writer 失败后主 Agent 不得普通 patch 代写；委派预算耗尽应立即终止，不能循环到父级 max steps。
- writer 成功但明确要求的 reviewer 失败时，不得合入提案；评审批次耗尽同样立即终止。
- Git writer worktree 必须包含父级创建时的 staged、unstaged 和非忽略 untracked 状态，同时不能改变父工作区；非 Git 夹具使用隔离副本。
- writer 可以在隔离工作区多次应用补丁，并运行允许列表内的测试、类型检查、Lint 或 Build；安装、Shell、联网和高风险命令必须拒绝。
- reviewer 工作区应物化 writer proposal，使其能检查补丁后的文件与真实 diff。
- proposal 必须携带基线指纹和子级验证结果；父级并发变化后重新校验，冲突返回 `DELEGATED_PATCH_CONFLICT`，不得覆盖父级内容。
- 间接请求“实现不太对，你处理一下”由模型 TaskFrame 解释；“只分析，不要修改”的结构化只读约束不能被动作升级突破。
- 说明历史修改、询问使用方式或询问“是否需要修改”不得因为历史动作词产生强制 Patch。
- 从 Web 动作继续选择 `read_file` 和 `APPLY_PATCH` 时保持同一个 `AGENT_TASK`，不能要求用户重新发起“编辑模式”任务。
- 服务商 `reasoning_content` 只产生“私有字段可用”的遥测；终端显示 reasoning token、决策理由和工具证据，不显示原始隐藏思维链。
- 解析边界会把旧模型输出的只读委派 Decision 归一化为当前 `DELEGATE` + `READ_ONLY`；运行时和新 Prompt 只有一种委派分支。
- 对同一目标使用中英文、释义、否定和条件表达生成 TaskFrame 回归，防止重新引入按关键词或子串选择 Direct/Web/Edit 的本地路由。

### 1.7 Conversation 与 Web 证据

覆盖：

- TaskFrame 使用最近 Conversation，并可通过语义查询选择更早证据。
- 当前请求始终是权威目标，旧消息只作为上下文或历史证据。
- 仅当 TaskFrame 标记 `PRIOR_RESPONSE_AUDIT` 时检查最终答复；若模型否认可见旧原话，运行时直接使用只判断“说过什么”、不判断外部真伪的记录型安全纠正。
- Web 行为由 TaskFrame evidence policy 约束：先搜索、再抓取、满足来源和引用要求。
- 首个搜索查询必须遵守 TaskFrame 范围；`ranking=REPRESENTATIVE` 时不能引入“最知名 / most famous / top / best”，`ranking=SUPERLATIVE` 时允许排名查询。
- `fetch_url` 只接受用户给出的 URL 或成功搜索返回的精确 URL；搜索失败后猜测来源地址必须在执行前拦截。
- `fetch_url` 对非 2xx、WAF JSON、CAPTCHA、安全验证和登录壳返回结构化失败，不能让 HTTP 200 的反爬页面满足证据门槛；HTTP / HTML 声明的 GB2312、GBK、GB18030 页面必须正确解码。
- Web 最终引用必须至少包含一个真正抓取过的页面；只在搜索结果出现的候选 URL 不算已检查来源。
- 搜索或抓取证据不足时必须确定性进入限制性终局，不允许编造实时事实，也不能因模型反复提交 `success=true` 而耗尽最大步数。
- 证据不足终局必须由结构化 `FINAL.evidenceStatus=INSUFFICIENT` 表达；仅在自然语言里出现“无法核验”不能绕过完成门禁。
- 重复的相同 Web 工具调用、provider/transport 失败后的等价换词重试由运行时拦截。

### 1.8 AgentLoop

覆盖：

- tool_call -> tool result -> final。
- apply_patch -> git diff -> final。
- run_command 成功。
- run_command 失败后进入下一轮。
- 自然语言 `FINAL` 必须满足 TaskFrame 问题形态：数量题给数字或范围化限制，枚举题给清晰列表，定义题真正定义对象，只有来源链接的结果必须拒绝。
- 写文件类任务如果没有成功 patch，不能直接 final 成功。
- 已经有代码上下文的“写进去 / 保存到文件”追问，不能反问用户重复提供代码或文件路径。
- 最大步数终止。
- session/event 写入。
- Plan 模式只向模型暴露只读工具。
- Plan 模式硬拦 `APPLY_PATCH`、`APPLY_DELEGATED_PATCH`、`RUN_COMMAND` 和伪装成 `TOOL_CALL apply_patch` 的写操作。
- 写代码目标可以在 Plan 模式正常 FINAL，而不会触发执行态的“必须已有 patch”后置条件。
- Plan 完成不生成 diff，Session 中记录 `TASK_SUMMARY.mode=PLAN`。

### 1.8.1 Agent Harness / Eval

覆盖：

- scripted LLM 能按预设 `AgentDecision` 驱动 AgentLoop。
- Harness 能创建临时 git 仓库、写入初始文件、执行 patch、读取 diff。
- Harness 能校验成功状态、diff 内容和文件内容。
- Harness 能统计步骤、LLM 调用、工具选择、工具选择准确率和失败类别。
- stdio 与 Streamable HTTP MCP fixture 能完成 initialize、tools/list 和 tools/call。
- 普通 Web 问题没有可读正文时进入证据不足回答；普通等级映射为单来源，当前等级要求多搜索视角与精确权威来源，明确多源和高风险等级才要求双来源/双域名。最终综合阶段即使模型继续提交不合规成功答案，也必须一次降级结束。
- Web 答案必须引用本轮真正抓取的 URL；不满足时 Guardrail 把具体缺口反馈给同一 AgentLoop，最终仍不合规则失败或进入证据不足终局。
- 长期记忆会排除过期和已被替代的条目，并支持可替换 embedding provider。
- 后续真实场景可以沉淀成 scenario，不再完全依赖人工 CLI 试用。

### 1.9 Diagnostics

覆盖：

- `doctor` 检查 Node、Git、ripgrep、包管理器、Git 仓库、配置、Session、日志和变更记录。
- 配置与 MCP 加载失败保留具体错误并脱敏。
- AgentLoop 的命令、工具、协议与 Guardrail 错误保持结构化代码和原始上下文。
- 项目不再维护基于自然语言错误文本的 `ErrorClassifier`；评测失败类别只依据实际运行记录和明确错误代码。

### 1.10 对话级回归集

新增一套独立的 CLI regression suite，目标不是单纯增加覆盖率，而是固定住已经踩过的真实问题。当前至少覆盖：

- 文件分析请求必须由 TaskFrame 选择 `read_file`，不能因任意问句分类而丢失读取能力。
- Web 研究后模型选择 `APPLY_PATCH` 时必须在同一 AgentLoop 写入，不要求用户切换模式。
- 明确只要代码片段时，模型可直接 `FINAL`，且不产生 Patch。
- 先回答代码、再要求写入文件时，Conversation 必须把旧代码提供给模型；是否写入由当前 TaskFrame 决定。
- 当前请求与旧 Session 冲突时以当前请求为准；需要较早原话时由 `conversationEvidence` 语义召回。
- Tool/Patch/Command decision 不能作为 assistant 自然语言消息污染后续 Conversation。
- “Kanye West 有哪些知名歌曲”显式联网时，查询不得把“知名”强化为“最知名”。
- 最新模型 TaskFrame 必须选择 `webEvidencePolicy.profile=CURRENT` 和对应语义依据；本地策略解析为 `freshness=CURRENT`、`authority=REQUIRED` 与至少两个搜索视角，Guardrail 据此要求权威检索、精确候选抓取和可见时效证据。
- 搜索质量能力必须对 provider 无关：候选归一化、跨源 URL 去重、fallback 和时效重排在通用 Pipeline 中完成。
- 最后 2 次综合预留中模型可见工具为空，运行时拒绝继续搜索、猜 URL、PLAN 或 ASK_USER。
- 数量答案不能用相邻类别替代用户请求的类别；无稳定总数时说明定义、范围、时间点或披露限制。
- “分析当前文件夹的项目”必须先读取真实仓库证据，再总结。
- 模型声称“已写入”但没有 Patch 时，必须被完成性 Guardrail 拦截。

执行命令：

```bash
pnpm test:regression
```

演示前快速验收：

```bash
pnpm verify:regression
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
mini-agent command run "pnpm test"
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
pnpm check:architecture
pnpm check:exports
pnpm check:docs
pnpm build
pnpm typecheck
pnpm lint:unused
pnpm test:regression
pnpm test
pnpm verify
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
