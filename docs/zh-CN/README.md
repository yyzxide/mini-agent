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

普通聊天、明确只要代码片段的请求和联网问答不会强行进入代码修改循环。当前版本会先用 `TaskRouter` 分成四类：

- `DIRECT_ANSWER`：普通问答、解释、明确只要代码片段的请求，输出 `[answer]`。
- `WEB_ANSWER`：需要最新资料或公网信息的问题，先执行 `web_search` / `fetch_url`，会优先考虑更像官方/高可信的来源，继承当前 session 的追问范围，并在前几个来源抓取失败时继续尝试后续候选来源，再输出更完整的 `[answer]`。这类问题包括最新版本、新闻、赛事比分、实时/收盘行情、汇率和市场指数等强时效查询。
- `CODE_REVIEW`：文件级代码审查和 bug 检查。CLI 会先读取目标文件，再自动补充少量由本地 import / include 解析出来的相关文件作为上下文，然后要求模型输出结构化 findings，先在本地校验引用代码是否真的出现在主文件里，再做一轮 review 复核，必要时把过度武断的结论降级或丢弃，输出 `[review]`。
- `AGENT_LOOP`：真正的仓库阅读、修改、测试和修复任务，输出 `[plan]`、`[tool]`、`[patch]`、`[command]`、`[summary]`。

对于“分析当前项目”“总结这个仓库”这类仓库分析请求，CLI 现在不会只依赖目录树摘要直接作答，而是会先强制执行一轮取证：列目录、读取 README / 构建文件、读取代表性源码文件，然后再让模型输出带文件依据的项目分析。

`WEB_ANSWER` 不是简单把用户原话丢给搜索引擎。它会先用 `WebQuestionPlanner` 结合 session 记忆生成独立问题、搜索 query、回答范围、来源提示和回答约束；规划失败时再用本地 fallback 策略补齐追问范围和 source-focused query。

对于 `葡萄牙呢`、`那这个呢`、`and Portugal?` 这种很短的追问，CLI 现在也会先结合当前 session 做一次本地补全；如果上一轮问法已经明确了省略掉的谓语或范围，就会先重写成更完整的问题，再决定走直接回答还是联网回答。

## 文档索引

- [架构设计说明](ARCHITECTURE.md)：解释 CLI Agent 的模块拆分、工具系统、权限、session 和 LLM 接入。
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
- 普通问答、联网问答、代码审查、仓库任务四种模式分流。
- 统一 ToolRegistry 和 zod 参数校验。
- `list_files`、`read_file`、`search_code`、`web_search`、`fetch_url`、`git_status`、`git_diff`、`apply_patch`。
- `read_file` / `search_code` 会拒绝 `.git`、`.mini-agent` 等内部元数据路径，代码搜索结果会统一为 POSIX 风格路径。
- 命令执行超时、输出截断和危险命令拦截。
- 常见运行错误本地诊断，例如运行目录错误、命令不存在、端口占用、连接拒绝和权限不足。
- patch 应用前 `git apply --check`，并固定 `core.autocrlf=false`，避免全局 Git 换行配置影响补丁结果。
- `.mini-agent/sessions` 和 `.mini-agent/events` 本地审计记录。
- `.mini-agent/logs` 运行日志和 `.mini-agent/change-log.jsonl` 任务变更日志，包含代码审查阶段信息，以及补充相关文件加载记录。
- `.mini-agent/memory/index.jsonl` 长期记忆索引，把任务总结和压缩记忆转成可检索历史，并通过查询构建、召回、重排和证据选择注入上下文。
- `.mini-agent/rag/index.jsonl` 文档知识索引，支持 Markdown/TXT 安全导入、按行分块、来源增量替换、关键词与向量混合检索、来源/标签过滤、行号引用和证据不足拒答。
- 长期记忆覆盖 Direct、Web、Review、RepositoryAnalysis 和 AgentLoop；支持离线或 OpenAI-compatible embedding、TTL、confidence、同主题 supersession、显式 remember/forget、失败过滤和密钥脱敏。
- 声明式 Skill：从版本化的 `skills/<name>/SKILL.md` 和本地 `.mini-agent/skills/<name>/SKILL.md` 发现、校验、自动选择并注入所有执行模式；Skill 只能指导现有受控工具，不能执行任意脚本或绕过权限。
- 真正的只读 Plan 模式：`mini-agent plan`、`/plan`、`/plan off`、`/execute`。Plan 状态会随 Session 保存，只向模型暴露只读工具，并在运行时硬拦 patch、命令和伪装成工具调用的写操作。
- MCP stdio/Streamable HTTP tools runtime，支持 initialize、工具发现、名称隔离、权限映射、调用转发和生命周期关闭。
- `AgentHarness` 和 `ScriptedLlmClient`，用于把多步 AgentLoop 场景变成可重复评测，并统计步骤、LLM 调用、工具选择和失败类别。
- `mini-agent config` 管理本地模型配置。
- `mini-agent --help`、`mini-agent run`、`mini-agent review`、`mini-agent tool`、`mini-agent mcp`、`mini-agent doctor`、`mini-agent logs`、`mini-agent changes`、`mini-agent memory` 等调试命令。
- `mini-agent session summary <sessionId>` 可以直接查看某个会话的压缩摘要。
- 代码生成请求默认会创建或修改仓库文件；只有明确要求“代码片段 / 不要改文件”时才走纯回答模式。
- 如果上一轮先给了代码片段，下一轮再说“写入一个文件里面”“写进去”“保存一下”“把刚才的代码保存到文件里”，CLI 会复用当前 session，把上一轮代码块补成明确写文件任务，再交给 `AGENT_LOOP` 落盘。
- 如果上一轮是代码落盘任务，下一轮继续说“数据流的中位数呢”这类短算法追问，CLI 会继承上一轮的仓库编辑模式，而不是退回到纯聊天贴代码。
- 如果用户问“你写入了嘛？”，CLI 会直接检查当前 session 里上一轮之后是否出现 `FILE_CHANGE` 记录；没有记录就明确说明没有查到本次落盘，不让模型凭记忆猜。
- 项目额外维护了一套“对话级回归测试”，专门覆盖真实用户最容易踩到的多轮场景。

## 核心回归测试

为了避免“每修一次又冒出一个新坑”，当前版本把真实踩过的问题固化成了一套独立回归集。重点覆盖：

- “代码片段 / 不要改文件”必须停留在 `DIRECT_ANSWER`
- 默认实现型请求必须真正写入文件
- `写入一个文件里面`、`写进去` 这类短追问必须承接上一轮代码
- `数据流的中位数呢` 这类代码连续追问必须继续走 `AGENT_LOOP`
- `你写入了嘛？` 这类确认问题必须基于 session 文件变更记录回答
- `葡萄牙呢` 这类短追问必须结合当前 session 补全语义
- “分析当前项目”必须先读取 README / 构建文件 / 代表性源码再总结

运行命令：

```bash
npm run test:regression
```

如果只是想在演示或提交前做一轮快速稳定性验收，可以运行：

```bash
npm run verify:regression
```

当前正常环境回归基线：36 个测试文件、262 个测试用例；提交前建议同时运行 `npm run typecheck` 和 `npm run lint:unused`。

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
/diff         查看 git diff
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
