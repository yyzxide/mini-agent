# 测试计划

当前项目只保留本地 CLI Agent，因此测试目标也收缩为：保证 CLI、任务分流、工具系统、AgentLoop、LLM 客户端、patch、命令执行和 session 记录稳定。

截至本轮修复，已验证：

- `tsc -p tsconfig.json --noEmit` 通过。
- `tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` 通过。
- 正常环境全量 Vitest 基线：59 个测试文件、522 个测试用例。
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

### 1.4.2 Long-term Memory

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

### 1.6 TaskRouter、TaskContract 和兼容标签

覆盖：

- `TaskUnderstanding` 先确定性产出 operation、target、answerShape、answerDepth、外部事实策略和权限信号；高置信度短追问不增加额外模型调用，条件、复杂否定与间接动作进入带 Conversation 的模型结构化补全，合并策略必须保留显式只读/联网/本地事实硬约束。
- 所有 CLI 请求最终都进入统一 `AgentLoop`，TaskRouter 只提供语义提示，`TaskContractBuilder` 负责编译能力和完成条件。
- 未显式传入契约的程序化调用方也使用语义推导契约；默认契约不授予仓库读取、写入、命令、Web、RAG、MCP 或委派能力。
- 普通聊天和明确声明“代码片段 / 不要改文件”的请求生成 `DIRECT_RESPONSE` 单步契约，并保留 `DIRECT_ANSWER` 兼容标签。
- 默认代码生成、仓库修改、测试和修复请求生成 `REPOSITORY_TASK`，并真正创建或修改仓库文件。
- 需要最新外部资料的问题生成 `WEB_RESEARCH` 契约，并保留 `WEB_ANSWER` 兼容标签。
- `ExternalFactPolicy` 区分一般知识、需要验证的精确/完整事实和非外部事实；“有哪些知名/代表性例子”保持 Direct，“全部/完整/有界清单”可以在执行前进入 Web。
- 即使前置路由漏判，`EvidenceRiskAssessor` 也会在 Direct 草稿发布前按有界关系、精确属性、强否定、时态、运行日期矛盾和最近纠错信号复核，并在同一 AgentLoop 中动态升级为 Web 契约。
- `AnswerQualityPolicy` 独立识别定义、数量、枚举、有界关系、身份和解释型回答；用户要求的简短/均衡/详细深度进入 Task Contract，不以最低字符数代替语义完成性。
- “世界杯”“股票”等主题名词不能单独强制联网；时效、精确属性、结果或显式研究意图仍应进入 Web。
- 代码审查与仓库分析共用 `REPOSITORY_INVESTIGATION` 只读契约，只区分输出要求。
- 多 Agent 默认可用；能力问句保持本地产品回答，明确“使用多个 subagent”进入仓库任务并成为完成条件，不依赖 CLI 开关。
- 子任务协议覆盖 `READ_ONLY`、`PROPOSE_CHANGES` 和依赖前序 writer 的 `REVIEW_CHANGES`；writer 补丁经过校验但不能直接改变主工作区。
- 主 Agent 只有在收到完成的 patch proposal 后才能执行 `APPLY_DELEGATED_PATCH`，并且合入后仍必须满足父级验证门禁。
- 子 Agent 的任务开始、只读工具调用、任务完成、变更文件和依赖关系会进入统一终端事件流。
- 子 Agent 每次 LLM 决策前显示 `thinking step`，之后显示结构化 decision 摘要；协议错误、恢复动作和最终失败原因不得被空状态覆盖。
- 新建独立文件的 writer 可以不读取无关仓库文件直接提交经校验的补丁；修改或删除已有文件仍必须先取得读取证据。
- 常见子级 JSON/Schema 协议错误进行有界恢复；恢复耗尽后保留精确错误。
- 明确要求子代理实现时，writer 失败后主 Agent 不得普通 patch 代写；委派预算耗尽应立即终止，不能循环到父级 max steps。
- writer 成功但明确要求的 reviewer 失败时，不得合入提案；评审批次耗尽同样立即终止。
- Git writer worktree 必须包含父级创建时的 staged、unstaged 和非忽略 untracked 状态，同时不能改变父工作区；非 Git 夹具使用隔离副本。
- writer 可以在隔离工作区多次应用补丁，并运行允许列表内的测试、类型检查、Lint 或 Build；安装、Shell、联网和高风险命令必须拒绝。
- reviewer 工作区应物化 writer proposal，使其能检查补丁后的文件与真实 diff。
- proposal 必须携带基线指纹和子级验证结果；父级并发变化后重新校验，冲突返回 `DELEGATED_PATCH_CONFLICT`，不得覆盖父级内容。
- 间接请求“实现不太对，你处理一下”可被模型语义补全为仓库修改；“只分析，不要修改”即使模型误判也必须保持只读；非法或低置信度语义 JSON 回退确定性结果。
- 服务商 `reasoning_content` 只产生“私有字段可用”的遥测，不作为 Direct 正文输出；终端显示 reasoning token、决策理由和工具证据，不显示原始隐藏思维链。
- 旧 `DELEGATE_READONLY` 会话记录仍可解析和恢复，但新 Prompt 只公开 `DELEGATE`。
- 英文关键词按词边界匹配，避免 `latest` 被误判成 `test`。
- 覆盖 `django`/`go`、`websocket`/`web`、项目管理/项目仓库等词汇碰撞，以及 `.txt`、`.mjs` 等普通文件修改，防止子串和有限样例表制造误路由。

### 1.7 Follow-up Resolver 与 Web 契约

覆盖：

- 根据结构化 Conversation 只补全短追问中省略的上一轮主题，不从压缩后的 session memory 文本重新解析另一份会话真相。
- “360”承接“腾讯有多少子公司”、“字节跳动呢”承接“腾讯有哪些核心产品”时，要恢复数量/枚举谓词，并用补全后的问题重建同类型契约。
- 普通隐式指代只选择紧邻上一轮，避免旧主题竞争；审计助手旧回答时不走该切片，而是从完整会话记录召回相关原话、相邻问题和后续纠正。
- 模型否认可见旧原话时触发一次有界修订；再次冲突时使用只判断“说过什么”、不判断外部真伪的安全回退。
- Web 行为由 `WEB_RESEARCH` 契约约束：先搜索、再抓取、满足独立来源和引用白名单。
- 首个搜索查询必须保持用户范围；“知名”不能被改写成未请求的“最知名 / most famous / top / best”排名。
- `fetch_url` 只接受用户给出的 URL 或成功搜索返回的精确 URL；搜索失败后猜测来源地址必须在执行前拦截。
- `fetch_url` 对非 2xx、WAF JSON、CAPTCHA、安全验证和登录壳返回结构化失败，不能让 HTTP 200 的反爬页面满足证据门槛。
- Web 最终引用必须至少包含一个真正抓取过的页面；只在搜索结果出现的候选 URL 不算已检查来源。
- 搜索或抓取证据不足时允许明确限制性答复并正常结束，不允许编造实时事实，也不能因“必须成功搜索”陷入连续失败死锁。
- 重复的相同 Web 工具调用、provider/transport 失败后的等价换词重试由运行时拦截。

### 1.8 AgentLoop

覆盖：

- tool_call -> tool result -> final。
- apply_patch -> git diff -> final。
- run_command 成功。
- run_command 失败后进入下一轮。
- 高风险 Direct 草稿必须被扣留，不能进入实时 Context 或 `ASSISTANT_MESSAGE`；升级后 State 应变为 `WEB_RESEARCH`，获得 Web 工具和新的研究步数预算。
- Web/Knowledge/Direct 的自然语言 `FINAL` 必须满足问题形态：数量题给数字或范围化限制，枚举题给清晰列表，定义题真正定义对象，只有来源链接的结果必须拒绝。
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
- 先测试 Skill、再创建五子棋，随后问“这个难度如何”时，`LATEST_REFERENT` 只提供最近的五子棋 exchange；包含“你之前说过……”等审计语义的请求必须先分类为 `PRIOR_RESPONSE_AUDIT`，不能被 latest-only 切片截断
- `long time no see` 必须走普通问答，不能进入 AgentLoop 或输出 `[diff]`
- “昨天法国队踢西班牙队，谁赢了”与“法国队vs西班牙队，谁赢了”必须直接进入 `WEB_ANSWER`
- 普通回答拒绝联网后再说“你用搜一下啊”，必须复用上一轮赛事问题，而不是搜索这句追问本身
- `/new` 后的实时赛果不得从旧 session 长期记忆中作答
- 名称、模型标识、处理路径和 `WEB_ANSWER` 能力说明必须由本地产品知识回答，不能虚构手动切换方式
- AgentLoop 的 tool/patch/command decision 不能作为 `ASSISTANT_MESSAGE` 进入后续聊天历史；旧 session 中紧随 `AGENT_DECISION` 的遗留消息也必须过滤
- 用户质疑助手较早的原话时，即使该 claim 已超出旧的 newest-16 边界，也必须用 `PRIOR_RESPONSE_AUDIT` 召回；若草稿仍否认原话，最终输出必须被修订并记录 Guardrail/Event
- “Kanye West 有哪些知名歌曲”属于代表性一般知识，不应仅因“有哪些”强制联网；若显式要求联网，查询不得擅自增加“最”，搜索不可达时必须输出可完成的证据不足说明
- “OpenAI 最新模型”一类时序最高级问题不能直接接受 DuckDuckGo 前五名：provider 第六名存在更新官方发布时必须经候选池重排进入前列；最终结论还必须有权威时效搜索，且不能忽略证据中的更高同系列版本
- 搜索质量能力必须对 provider 无关：两个任意命名的 fake provider 应经过同一候选归一化、跨源 URL 去重、fallback 和时效重排，DuckDuckGo HTML 解析不得进入通用 Pipeline/Policy
- “Claude 最新模型”一类查询允许把 `site:官方域名 + 当前年份` 识别为权威时效检索意图，但必须抓取该次搜索返回的精确站内候选，且正文包含版本、日期、发布、更新或当前状态证据；站外噪声、只搜不抓、抓取其它第三方结果以及无时效内容的公司页都不能满足守卫
- 连续重复同一个 Final Guardrail 时，错误必须保留具体 guardrail code 和恢复动作，不能与普通模型或工具失败合并为笼统的连续失败
- Web Research 默认决策上限为 14；`WebResearchProgress` 必须依次表达普通召回、权威搜索、来源检查、证据比较和最终综合的完成状态，并在上下文中展示唯一推荐动作
- 最新类任务已有一个普通搜索视角后，第二个 `web_search` 若仍非权威时效查询必须被拦截；最后 2 次综合预留中模型可见工具必须为空，运行时也必须拒绝猜 URL、继续搜索、PLAN 或 ASK_USER
- “第三章 Boss 是谁”“某公司负责人是谁”等跨领域有界关系即使初始被分到 Direct，也必须在草稿发布前升级取证；“运行于 2026 年却声称尚未发布、计划 2024 年发布”必须命中确定性日期矛盾
- 最近刚发生事实纠错时，新草稿继续输出日期、版本、发布、位置等精确外部结论必须提高证据等级；正确承认并撤回旧错误不能被误判为重新发布事实
- “光合作用是什么”“解释哈希表原理”等普通定义和原理说明，以及仓库工作和产品能力问题，不应被声明审计无差别升级到 Web
- “世界杯是什么”“股票是什么”必须保持普通定义路径；“世界杯最新比分”“股票今天收盘价格”仍进入 Web
- 精确数量和 Direct 动态升级后的有界事实默认需要两个独立抓取来源；限制性回答仍可以在明确说明证据不足时结束
- 数量答案不能用投资对象、合作伙伴等相邻类别替代用户请求的类别；无稳定总数时必须说明定义、统计范围、时间点或披露限制
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
