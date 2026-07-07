# 架构设计说明

## 1. 当前定位

`mini-coding-agent` 是一个本地 CLI 形态的 AI Coding Agent。用户在某个 git 仓库中运行 CLI，输入自然语言任务，Agent 通过一组受控工具完成代码搜索、文件读取、联网搜索资料、联网读取公开文档、补丁应用、命令执行、测试反馈和 diff 总结。

它的主业是代码任务，但不应该丢失正常 AI 助手的基础能力。普通非代码问题会走直接回答；需要外部时效信息的问题会进入联网回答模式，通过受控联网工具搜索和读取资料；真正需要读写仓库、执行命令和修复问题的任务才进入 AgentLoop。

当前版本不内置后端服务和前端页面。所有核心能力都在 TypeScript CLI Runner 中完成。

## 2. 总体链路

```text
CLI
 -> TaskRouter
 -> DIRECT_ANSWER / WEB_ANSWER / AGENT_LOOP
 -> OpenAICompatibleClient / ToolRegistry / ContextBuilder
 -> AgentDecision / PatchManager / CommandRunner
 -> SessionStore / EventStore
 -> answer 或 final summary + git diff
```

核心循环：

1. 初始化 `AgentState`。
2. 构建仓库上下文和当前 session 的短期记忆。
3. 先用 `TaskRouter` 判断是直接回答、联网回答，还是进入仓库 AgentLoop。
4. 直接回答任务只调用文本 LLM，不改文件。
5. 联网回答任务先调用 `web_search`，再按需要调用 `fetch_url`；如果前几个来源抓取失败，会继续尝试后续候选来源，最后把资料交给文本 LLM 生成完整回答。
6. 仓库任务调用真实 LLM，解析出 `AgentDecision`。
7. 根据 decision 执行工具、应用 patch、运行命令或结束。
8. 命令失败时把日志放回上下文。
9. 达到 final 或最大步数后输出总结和 diff。

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
src/web              联网问题规划、追问改写和搜索源策略
src/config           本地配置文件读取和脱敏
src/utils            路径安全、错误处理、运行日志
tests                自动化测试
```

## 4. AgentDecision

`TaskRouter` 在进入 AgentLoop 之前先做轻量分流：

- 普通问答和独立代码片段走 `DIRECT_ANSWER`，只输出答案，不改仓库。
- 需要最新资料、新闻、版本、赛事结果等外部信息的问题走 `WEB_ANSWER`，输出基于搜索资料的答案，不改仓库。
- 文件级 bug 检查和代码审查走 `CODE_REVIEW`，先读取目标文件，再额外加载少量由相对 import、require、`#include` 推导出来的相关文件作为补充上下文，再让模型返回结构化 findings，先由本地代码校验 `codeQuote` 是否真的落在主文件对应行附近，再做一轮 review 复核，进一步过滤“引用代码是真的，但结论过度武断”的 finding。
- 明确提到仓库、文件、修改、测试、修复等任务走 `AGENT_LOOP`。
- 对于“分析当前项目”“总结当前仓库”这类仓库分析请求，CLI 虽然仍归在 `AGENT_LOOP` 大类下，但会先执行一条本地强制取证路径：列出目录、读取 README / 构建文件、读取代表性源码文件；如果没有读到源码文件，就拒绝直接总结。这样能避免模型只看目录树摘要就给出看似正确、实则不够扎实的概述。
- “刚才聊了什么 / 还记得吗 / 上次呢”这类会话追问走 `DIRECT_ANSWER`，但会带上当前 session 的最近记录。
- `--agent-loop` 可以强制进入仓库修改流程。

`WEB_ANSWER` 会先调用 `WebQuestionPlanner` 生成搜索计划：

- `standaloneQuestion`：把追问改写成可以独立搜索的问题。
- `searchQueries`：生成 1 到 4 条搜索 query。
- `answerScope`：明确回答范围。
- `sourceHints`：提示优先找官方、实时、发布说明、比分页等来源。
- `answerInstructions`：约束回答不要混淆赛事、版本、政策或其它领域边界。
- `needsLiveData`：标记是否属于实时或强时效问题。

规划优先由 LLM 根据 session memory 完成；如果规划失败，会回退到本地启发式策略。例如上一轮问“世界杯最新比分”，下一轮问“日本队最近几场的成绩”，搜索 query 会携带“世界杯”范围，避免泛化成日本国家队所有友谊赛、预选赛或其它赛事成绩。

对于 `葡萄牙呢`、`那这个呢` 这类很短的追问，CLI 还会先做一层本地 follow-up 重写：如果上一轮用户问题已经明确了省略掉的谓语或范围，例如“西班牙是强队吗”，那么短追问会先被补成“葡萄牙是强队吗”，再继续走路由和回答流程。

对于 EDG、T1、Apple 这类可能跨游戏、跨产品或跨领域的实体，如果用户没有指定领域，规划器不能默认选择一个方向。它会生成更宽的 query，并要求最终回答按领域列出主要可能，或提示用户补充范围。例如“EDG 哪一年夺冠了”应区分《英雄联盟》S11 2021 年和《无畏契约》Valorant Champions 2024 年，而不是只回答其中一个。

对于实时比分、版本发布、政策新闻等强时效问题，fallback 策略会自动追加 source-focused query。例如赛事比分会优先尝试官方赛事站、比分页和赛程结果页；版本问题会追加官方 release notes、changelog 和 GitHub releases。

当前联网工具是受控公网搜索和页面抓取，不是实时比分或商业搜索 API。遇到动态比分页、反爬页面或 JS 渲染页面时，工具可能只能拿到摘要或拿不到结构化数据。此时回答必须说明“无法核验实时比分”，不能编造结果。

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

当前 `web_search` 默认先尝试 DuckDuckGo HTML 结果页做轻量解析；如果 HTML 结果为空或质量不够，再降级到 DuckDuckGo Lite。CLI 在抓取来源前还会结合域名可信度、query 词项覆盖、官方/发布页特征和域名去重做一轮排序，尽量优先抓取更像官方说明、release notes、比赛结果页的来源，避免前三条都落在同一站点上。后续如果需要更稳定的生产效果，可以继续接 Brave、Tavily、SerpAPI 或企业内部搜索 API。

## 7.5 仓库状态分析

`git status`、`git diff`、`git log` 只属于事实层，不能直接等价于 Agent 对仓库的理解。当前版本增加了 `RepoStateAnalyzer`，用于把多种信号合成更适合模型和用户阅读的状态摘要：

- git 分支、commit、变更文件和 diff 统计。
- 项目构建文件，例如 `package.json`、`pom.xml`、`go.mod`。
- 主要语言分布。
- package scripts。
- 建议验证命令，例如 `npm test`、`pnpm test`、`mvn test`、`go test ./...`。

这层摘要主要用于仓库视角的状态查看：交互式请使用 `/repo`，非交互模式可以使用 `mini-agent status` 或 `mini-agent repo`；`mini-agent git status` 仍保留为底层 git 调试命令。

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
  change-log.jsonl
  sessions/<sessionId>.jsonl
  events/<sessionId>.jsonl
  logs/YYYY-MM-DD.jsonl
```

Session 更像最终状态记录，Event 更像时间线。二者都用 JSONL，是因为：

- 易追加。
- 易人工查看。
- 不依赖数据库。
- 崩溃时仍保留已写入步骤。
- 以后可以被别的系统读取。

新增的运行日志和任务变更日志解决两个不同问题：

- `logs/YYYY-MM-DD.jsonl` 是排障日志，记录任务开始/结束、工具调试、命令执行、patch 应用、CLI 异常，以及 `CODE_REVIEW` 的关键阶段，例如 review target 解析、主文件加载、补充文件加载、grounding 和 verification。日志会做基础脱敏，例如 API key、authorization、token、password 等字段不会明文写入。
- `change-log.jsonl` 是复盘日志，记录每次任务的 session、任务文本、执行模式、成功失败、摘要、当前变更文件、diff stat 和测试结果。对于 `CODE_REVIEW`，还会额外记录 review file、loaded lines、supplemental files、findings 数量、rejected 数量和最终 verdict。它适合做 review、demo 复盘和面试材料整理。

交互式 CLI 启动时会创建一个活跃 session；用户连续输入多轮任务时复用同一个 session，只有 `/new` 才会创建新 session，`/exit` 会结束当前 session。`mini-agent resume <sessionId>` 会重新打开指定 session，并继续把该 session 的最近记录作为上下文。

交互式 CLI 也支持 `/resume <sessionId>` 在当前进程中切换历史 session，支持 `/history` 查看当前 session 记录，支持 `/events` 查看事件时间线，支持 `/logs` 和 `/changes` 查看运行日志和任务变更日志。

命令行输入体验分成两层：

- 交互式 `mini-agent` 内部，依赖 Node `readline` 的 completer，为 `/status`、`/repo`、`/review` 这类 slash 命令提供 `Tab` 补全。

`SessionMemory` 会把最近的用户消息、助手消息、任务总结、工具结果、命令结果、错误和压缩记忆记录拼成一段短期记忆。`ContextBuilder` 在 AgentLoop 每轮调用 LLM 前注入这段记忆；直接回答模式和联网回答模式也会把这段记忆放进文本回答请求中。因此它能回答“刚才我们聊了什么”这类当前会话追问。

`/compact` 当前是第一版本地压缩：它把最近 session 记录压成一条 `MEMORY_COMPACTION` 写回 session，避免长会话完全依赖原始消息堆积。它还不是向量数据库或长程 RAG，后续可以升级为“LLM 摘要 + 关键词索引 + 文件级检索”的混合记忆。

当前这层记忆是 transcript memory，不是完整 RAG。它解决同一会话连续性；如果要跨仓库、跨天、跨长文档检索，需要后续再加索引、摘要和向量/关键词检索。

## 10.5 CLI 诊断和常用 slash 命令

顶层诊断命令：

- `mini-agent doctor`：检查 Node、git、rg、pnpm、模型配置、仓库状态、session/log/change-log 状态。
- `mini-agent logs`：查看最近运行日志。
- `mini-agent changes`：查看最近任务变更日志。

交互式 slash 命令：

- `/help`：查看命令。
- `/new`：开启新会话。
- `/review <file>`：直接对单个仓库文件做代码审查。
- `/resume <sessionId>`：切换历史会话。
- `/session`：查看当前 session 元信息。
- `/summary`：查看当前 session 的压缩摘要，不写入记录。
- `/sessions`：列出 session，并显示最近消息/摘要提示。
- `/history [n]`：查看当前 session 最近记录。
- `/events [n]`：查看当前 session 最近事件。
- `/logs [n]`：查看最近运行日志。
- `/changes [n]`：查看最近任务变更日志。
- `/compact`：写入一条本地压缩记忆。
- `/status`：查看当前 session 状态，包括最近模式、最近摘要和已记录的 LLM token 用量。
- `/repo`：查看仓库状态摘要。
- `/diff`：查看当前 diff。

另外，非交互模式也支持 `mini-agent session summary <sessionId>`，用于把某个历史会话快速压缩成可阅读摘要；如果传 `--write`，还会把摘要写回 `MEMORY_COMPACTION` 记录。`mini-agent session status <sessionId>` 则会输出该会话的 JSON 状态，包括本地累计 token 使用量；剩余上下文窗口通常无法精确获得，因为大多数 OpenAI-compatible API 不返回这个值。
- `/clear`：清屏。
- `/exit`：结束当前 session 并退出。

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
