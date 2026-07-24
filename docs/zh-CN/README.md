# mini-coding-agent 中文文档

`mini-coding-agent` 现在定位为一个纯本地运行的 AI Coding Agent CLI。

它不再内置 Java 后端、Web 前端或沙箱控制面。项目主线收敛为：

```text
自然语言任务
-> 构建仓库上下文
-> 调用真实大模型
-> 搜索/读取代码
-> 生成并应用 patch
-> 执行命令或测试
-> 根据失败日志继续修复
-> 输出总结和 git diff
-> 保存本地 session/event
-> 索引长期记忆供后续任务检索
```

当前版本不再为普通问答、联网问答、代码审查和仓库分析维护四套执行器。每条请求都会先生成 `AgentTaskContract`，再进入同一个 `AgentLoop`：

- `DIRECT_RESPONSE`：单步回答契约，不开放工具和仓库访问，输出 `[answer]`。
- `WEB_RESEARCH`：只开放 `web_search` / `fetch_url`；实时事实要求两个独立域名的可读正文，最终引用必须来自本轮工具证据，输出 `[answer]`。
- `REPOSITORY_INVESTIGATION`：代码审查与仓库分析共用的只读调查契约。两者只在输出要求上不同，分别输出 `[review]` 或 `[summary]`。
- `REPOSITORY_TASK`：开放仓库读取、补丁、受控命令、验证、RAG/MCP，以及默认可用的多 Agent 调查、隔离补丁提案和依赖式审查；只有主 Agent 能合入提案。
- `KNOWLEDGE_QUERY`：只使用 `knowledge_search`，最终回答必须保留文件与行号引用。
- `PLAN`：叠加在任务契约上的只读操作模式，运行时再次硬拦补丁和命令。

旧的 `DIRECT_ANSWER`、`WEB_ANSWER`、`CODE_REVIEW` 标签仍保留在 session/change-log 元数据中，用于兼容历史记录；新记录会同时写入 `executionEngine: AGENT_LOOP`、`taskKind` 和 `outputKind`。

CLI 现在会按时间线显示 Conversation 历史、Context 构建、显式计划、工具输入与结果、补丁、命令实时输出、Guardrail、LLM 调用和最终结果。直接回答单独显示实际传给模型的历史消息数和估算 Token；仓库与联网任务在 Context 预算下显示 Session Memory 的记录选择与压缩情况。`--verbose` 展开 Token、Context 压缩、Prompt Cache 与 Embedding Cache 指标，`--trace` 进一步显示经过脱敏的 AgentDecision、Conversation 角色序列和逐 Context Section 分配；`--event-stream` 输出同一套版本化 `AgentRuntimeEvent`，供日志和自动化消费。系统不输出模型隐藏思维链，只显示可审计的计划、结构化决策和证据。

写入仓库的任务结束后只显示紧凑的 `Changes` 卡片，不在执行时间线中铺开代码。交互式 TTY 中可以点击卡片或按 Enter 打开终端内置的全屏 Diff Viewer，使用方向键切换文件、PageUp/PageDown 或滚轮滚动、`q`/Esc 返回；非交互任务会显示 `mini-agent diff --session <id>`。任务 Diff 使用独立临时 Git 索引捕获前后工作树 Tree，因此能包含新建代码、Markdown 等未跟踪文件，同时排除任务开始前已经存在的脏改动，并且不会改变用户真实暂存区。

对于“分析当前项目”“总结这个仓库”这类请求，调查契约只暴露仓库只读工具，并在至少成功读取一个相关文件之前拒绝成功结束。代码审查走完全相同的调查链，只附加 finding、严重级别、文件和行号等输出要求。

对于 `葡萄牙呢`、`那这个呢`、`and Portugal?` 这种很短的追问，CLI 现在也会先结合当前 session 做一次本地补全；如果上一轮问法已经明确了省略掉的谓语或范围，就会先重写成更完整的问题，再决定走直接回答还是联网回答。

对于上一轮刚产生文件变更后的 `在哪里`、`放哪了`、`哪个文件`、`怎么打开`，CLI 不再让模型猜测指代对象，而是只读取紧邻上一轮的 `FILE_CHANGE` 记录，返回仓库内的绝对路径，并显示 `[follow-up] ... LLM skipped`。明确的 `你在哪里` 或 `北京在哪里` 不会被当成文件追问。

## 文档索引

- [架构设计说明](ARCHITECTURE.md)：解释 CLI Agent 的模块拆分、工具系统、权限、session 和 LLM 接入。
- [架构演进记录](ARCHITECTURE_EVOLUTION.md)：简要保留关键设计从 A 到 B 的问题、迁移方法、兼容取舍和下一步方向。
- [项目现状评估](PROJECT_STATUS.md)：当前完成度、100 分制评分、与 Claude Code/Codex 的差距、后续优先级。
- [AI Agent 面试学习指南](AI_STUDY_GUIDE.md)：按优先级学习 LLM、Tool Calling、Agent Loop、Context、RAG、Eval、MCP、安全和 AI 后端工程。
- [RAG 使用、设计与评测指南](RAG_GUIDE.md)：文档导入、混合检索、引用拒答、评测指标和生产化边界。
- [简历包装与求职使用说明](RESUME_PACKAGE.md)：怎么写进简历、怎么讲项目、适合投什么岗位。
- [演示脚本](DEMO_SCRIPT.md)：用于本地演示和录屏的操作步骤。
- [面试讲解稿](INTERVIEW_GUIDE.md)：把项目讲成一个完整工程故事。
- [面试问答](INTERVIEW_QA.md)：常见追问和回答。
- [测试计划](TEST_PLAN.md)：CLI 项目的自动化和手工测试范围。
- [自测清单](SELF_TEST_CHECKLIST.md)：提交前按项检查。
- [Roadmap](ROADMAP.md)：后续增强方向。

## 一句话介绍

这是一个 TypeScript 实现的本地 AI Coding Agent CLI。它可以在任意 git 仓库中接收自然语言任务，通过受控工具搜索代码、读取文件、搜索公网资料、读取公网文档、应用补丁、执行命令、查看测试反馈，并把整个过程记录到本地 JSONL session。

## 核心能力

- 真实 OpenAI-compatible API 接入。
- 单一 AgentLoop 与契约化的能力、证据、输出和预算控制。
- 统一 ToolRegistry 和 zod 参数校验。
- `list_files`、`read_file`、`search_code`、`web_search`、`fetch_url`、`git_status`、`git_diff`、`apply_patch`。
- `read_file` / `search_code` 会拒绝 `.git`、`.mini-agent` 等内部元数据路径，代码搜索结果会统一为 POSIX 风格路径。
- 命令执行超时、输出截断和危险命令拦截。
- 终端运行时间线与命令实时输出，支持 `--verbose`、`--trace` 和脱敏的机器事件流。
- Prompt/Completion/Reasoning Token、Prompt Cache read/write、Context/Session 压缩和 Embedding Cache 命中遥测；服务商未报告的数据明确显示为 unknown/unreported。
- Session Memory 使用字符/Token 双预算的分层压缩；用户硬约束、最近对话和执行证据分别选择，`--trace` 可查看来源、裁剪状态与保留原因。
- 常见运行错误本地诊断，例如运行目录错误、命令不存在、端口占用、连接拒绝和权限不足。
- patch 应用前 `git apply --check`，并固定 `core.autocrlf=false`，避免全局 Git 换行配置影响补丁结果。
- `.mini-agent/sessions` 和 `.mini-agent/events` 本地审计记录。
- `.mini-agent/logs` 运行日志和 `.mini-agent/change-log.jsonl` 任务变更日志；新任务会记录统一执行引擎、任务类型和输出契约。
- `.mini-agent/memory/index.jsonl` 长期记忆索引，把任务总结和压缩记忆转成可检索历史，并通过查询构建、召回、重排和证据选择注入上下文。
- `.mini-agent/rag/index.jsonl` 文档知识索引，支持 Markdown/TXT 安全导入、按行分块、来源增量替换、关键词与向量混合检索、来源/标签过滤、行号引用和证据不足拒答。
- `.mini-agent/cache/embeddings/v1/` 远端 embedding 内容寻址缓存，按 provider/vector-space 和文本哈希隔离，不保存原文，并支持内存 LRU、并发 single-flight 与跨进程磁盘复用。
- 长期记忆按统一任务结果治理；支持离线或 OpenAI-compatible embedding、TTL、confidence、同主题 supersession、显式 remember/forget、失败过滤和密钥脱敏。
- 声明式 Skill：从版本化的 `skills/<name>/SKILL.md` 和本地 `.mini-agent/skills/<name>/SKILL.md` 发现、校验、自动选择并注入所有执行模式；Skill 只能指导现有受控工具，不能执行任意脚本或绕过权限。
- 真正的只读 Plan 模式：`mini-agent plan`、`/plan`、`/plan off`、`/execute`。Plan 状态会随 Session 保存，只向模型暴露只读工具，并在运行时硬拦 patch、命令和伪装成工具调用的写操作。
- MCP stdio/Streamable HTTP tools runtime，支持 initialize、工具发现、名称隔离、权限映射、调用转发和生命周期关闭。
- `AgentHarness` 和 `ScriptedLlmClient`，用于把多步 AgentLoop 场景变成可重复评测，并统计步骤、LLM 调用、工具选择和失败类别。
- `mini-agent config` 管理本地模型配置。
- `mini-agent --help`、`mini-agent run`、`mini-agent review`、`mini-agent tool`、`mini-agent mcp`、`mini-agent doctor`、`mini-agent logs`、`mini-agent changes`、`mini-agent memory` 等调试命令。
- `mini-agent session summary <sessionId>` 可以直接查看某个会话的压缩摘要。
- 代码生成请求默认会创建或修改仓库文件；只有明确要求“代码片段 / 不要改文件”时才走纯回答模式。
- 设计文档、README、技术报告等明确文档创建请求同样进入 `AGENT_LOOP`，必须真正应用 Markdown patch；咨询“如何写文档”或明确要求只在聊天展示时仍走纯回答。
- 如果上一轮先给了代码片段，下一轮再说“写入一个文件里面”“写进去”“保存一下”“把刚才的代码保存到文件里”，CLI 会复用当前 session，把上一轮代码块补成明确写文件任务，再交给 `AGENT_LOOP` 落盘。
- 如果上一轮是代码落盘任务，下一轮继续说“数据流的中位数呢”这类短算法追问，CLI 会继承上一轮的仓库编辑模式，而不是退回到纯聊天贴代码。
- 如果用户问“你写入了嘛？”，CLI 会直接检查当前 session 里上一轮之后是否出现 `FILE_CHANGE` 记录；没有记录就明确说明没有查到本次落盘，不让模型凭记忆猜。
- 产品能力以 `Capability Registry` 为唯一事实源；能力咨询通过主体、能力主题、疑问/情态和历史解释等组合信号识别，不按完整问句逐条特判。模型最终回答若错误否认已注册的联网或仓库写入能力，运行时会纠正并留下审计事件。
- 项目额外维护了一套“对话级回归测试”，专门覆盖真实用户最容易踩到的多轮场景。

## 核心回归测试

为了避免“每修一次又冒出一个新坑”，当前版本把真实踩过的问题固化成了一套独立回归集。重点覆盖：

- “代码片段 / 不要改文件”必须停留在 `DIRECT_ANSWER`
- 默认实现型请求必须真正写入文件
- `写入一个文件里面`、`写进去` 这类短追问必须承接上一轮代码
- `数据流的中位数呢` 这类代码连续追问必须继续走 `AGENT_LOOP`
- `你写入了嘛？` 这类确认问题必须基于 session 文件变更记录回答
- `葡萄牙呢` 这类短追问必须结合当前 session 补全语义
- `Skill -> 五子棋 -> 这个难度如何` 必须只指向最近的五子棋任务，不能被旧主题、长期记忆或 Skill 注入带偏
- “分析当前项目”必须先读取 README / 构建文件 / 代表性源码再总结
- “完整读取 / 全面审查某个文件”必须分页覆盖第 1 行到 EOF；只读文件开头时不能成功结束

运行命令：

```bash
npm run test:regression
```

如果只是想在演示或提交前做一轮快速稳定性验收，可以运行：

```bash
npm run verify:regression
```

当前正常环境回归基线：51 个测试文件、423 个测试用例；提交前建议同时运行 `npm run typecheck` 和 `npm run lint:unused`。

## 快速验证

```bash
npm install
npm run build
npm run typecheck
npm run lint:unused
npm run test:regression
npm test
npm link
mini-agent --help
mini-agent tool list
mini-agent tool manifest
mini-agent mcp tools
mini-agent doctor
```

配置真实模型：

```bash
cp mini-agent.config.example.json mini-agent.config.json
```

然后编辑 `mini-agent.config.json` 中的 `baseUrl`、`apiKey` 和 `model`。

交互模式常用命令：

```text
/help         查看命令帮助
/new          新开会话
/review <p>   审查单个仓库文件
/resume <id>  切换到历史 session
/pause        暂停当前会话并退出，后续可继续恢复
/summary      查看当前会话压缩摘要
/sessions     列出带最近消息/摘要提示的会话
/history [n]  查看当前 session 最近记录
/events [n]   查看当前 session 最近事件
/logs [n]     查看运行日志
/changes [n]  查看任务变更日志
/compact      写入一条本地压缩记忆
/memory <q>   检索本地长期记忆
/remember <t> 显式保存长期记忆
/forget <id>  删除一条长期记忆
/skills [n]   列出 Skill 或查看指定 Skill
/plan [task]  进入只读规划模式，可立即规划任务
/plan off     退出规划模式但不自动执行
/execute      执行当前 Session 最近一份成功计划
/status       查看当前会话状态与已记录的 LLM token 用量
/repo         查看仓库状态摘要
/diff         打开当前 Session 最近一次任务的终端 Diff Viewer
/exit         结束会话
```

交互模式里现在支持 `Tab` 补全 slash 命令，例如输入 `/sta` 后按 `Tab` 会补成 `/status`；如果一个前缀对应多个命令，连续按 `Tab` 可以看到候选列表。

临时离开时用 `/pause`，session 状态会变成 `PAUSED`，之后可以执行 `mini-agent resume <sessionId>` 或在交互模式中 `/resume <sessionId>` 接着使用。`/exit` 表示这个 session 已结束，会标记为 `FINISHED`。

其中交互式 `/status` 现在是“会话状态”语义：会显示当前 session、最近一次模式、最近用户消息、最新摘要、已配置模型，以及本地累计的 prompt/completion/total token。至于“当前还剩多少上下文 token”，大多数 OpenAI-compatible API 不会直接返回，所以这里只会明确标记为暂不可得。

如果要看仓库层面的变更摘要，请用 `/repo`。非交互模式下，`mini-agent status` 和 `mini-agent repo` 仍然输出仓库状态摘要；`mini-agent session status <sessionId>` 输出某个会话的 JSON 状态。

## 项目边界

当前版本故意不包含：

- Web 页面。
- Java 后端。
- Swagger。
- Docker 控制面。
- 远程 PR 自动创建。

如果要做企业后台或软件商店后台，建议作为独立项目实现，不混进这个 CLI Agent 仓库。
