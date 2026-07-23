# 架构设计说明

本文描述当前代码的可验证事实。关键设计从旧方案到当前方案的迁移原因、取舍和后续方向，见 [架构演进记录](ARCHITECTURE_EVOLUTION.md)。

## 1. 架构定位

`mini-coding-agent` 是一个本地 TypeScript CLI Agent。当前架构采用“单一 AgentLoop + 任务契约 + 确定性执行内核”：

- LLM 提议下一步决策。
- Task Contract 限定本次任务能看到和使用的能力。
- 本地代码负责输入校验、权限、工具执行、证据检查和完成性判断。
- Session、Event 和 Checkpoint 保存可恢复的执行轨迹。

普通回答、Web 研究、代码审查、仓库分析和仓库修改不再拥有各自的 Task Executor。它们全部进入同一个 `AgentLoop`，差异只由契约表达。

## 2. 总体链路

```text
CLI
 -> TaskRouter（语义提示，不选择执行器）
 -> TaskContractBuilder
 -> AgentTaskContract
 -> AgentLoop
    -> ContextBuilder
    -> LlmClient
    -> AgentDecision
    -> Capability / Permission / Completion Guardrails
    -> ToolRegistry / Patch / Command / Read-only delegation
 -> SessionStore / EventStore / Checkpoint
 -> answer / review / summary / diff
```

CLI 的任务分派只有一个目标：`runAgentLoopTask`。旧的 `DirectAnswerTask`、`WebAnswerTask`、`CodeReviewTask` 和 `RepositoryAnalysisTask` 已移除。

产品自身能力采用三层事实链，避免把某几句用户问法硬编码成特殊执行流程：

```text
Capability Registry（产品事实）
 -> Product Meta Classifier（组合识别主题、语气、疑问与历史解释意图）
 -> TaskRouter / 本地确定性回答

LLM 最终回答
 -> Capability Truth Guard
 -> 与 Registry 冲突时纠正并记录审计事件
```

## 3. AgentTaskContract

`src/agent/AgentTaskContract.ts` 定义统一任务契约。主要字段包括：

- `kind`：任务的语义类型。
- `outputKind`：最终输出要求。
- `executionStrategy`：单步文本回答或多步决策循环。
- `capabilities`：仓库读写、命令、Web、知识库、MCP、委派等能力开关。
- `evidence`：成功结束前必须满足的证据门槛。
- `maxSteps`：本次任务的默认步数预算。
- `instructions`：任务特定输出和调查要求。
- `resultMode`：兼容历史 session/change-log 的旧标签。

当前主要契约：

| Task kind | 能力 | 典型输出 |
|---|---|---|
| `DIRECT_RESPONSE` | 无工具、无仓库访问 | 普通回答、代码片段 |
| `WEB_RESEARCH` | `web_search`、`fetch_url` | 带本轮来源的联网回答 |
| `REPOSITORY_INVESTIGATION` | 仓库只读工具 | 代码审查或仓库分析 |
| `REPOSITORY_TASK` | 仓库读写、命令、验证，可选 RAG/MCP/委派 | 修改结果与 diff |
| `KNOWLEDGE_QUERY` | `knowledge_search` | 带文件行号引用的知识回答 |

契约能力只描述“当前这一条请求的最小权限”，不能被解释为整个产品的能力清单。例如 `DIRECT_RESPONSE` 本轮没有写文件和 Web 工具，不代表 Mini Coding Agent 不能写文件或联网；下一条编辑请求会建立 `REPOSITORY_TASK`，时效信息请求会建立 `WEB_RESEARCH`。能力清单、能力确认以及“为什么上一轮否认某项能力”属于本地产品元问题，由确定性产品事实回答，不进入 Web 研究。

### 3.1 Capability Registry 与产品元问题

`src/agent/CapabilityRegistry.ts` 是产品能力的唯一事实源，集中声明能力是否支持、对应任务契约、工具、描述和限制。提示词、确定性回答和输出校验都从这里生成，不能各自维护相互漂移的文案或事实。

`ProductCapability` 不枚举完整问句，而是组合以下语义信号：

- 产品主体：你、这个 CLI、Mini Agent 等。
- 能力主题：联网研究、仓库写入或全局能力清单。
- 言语行为：询问可用性、索要能力清单、解释上一轮限制。
- 情态与疑问：能否、是否支持、为什么、上一轮等。

因此“你能联网吗”“所以以后也碰不到外网吗”“刚才那个权限是永久的吗”可以归入同一产品元意图，而“请联网搜索 Node.js 版本”仍是需要真正执行的 Web 任务。规则只承担高置信度结构识别；未达到阈值的开放表达仍交给模型理解。

模型可以解释自然语言，但不能定义产品事实。`CapabilityTruthGuard` 会检查 `FINAL` 中“不能联网”“不能修改仓库”等全局能力否认；当用户确实在讨论产品能力且回答与 Registry 冲突时，运行时会替换为权威事实，并写入 `CAPABILITY_CLAIM_CORRECTED` 事件。它不会改写普通任务中合理的权限错误或暂时性失败。

### 3.2 ExternalFactPolicy

外部事实是否进入 Web 不只看“最新/联网”关键词。`ExternalFactPolicy` 先判断证据等级：

- `NOT_EXTERNAL_FACT`：仓库工作、产品元问题、计算、创作和只审计“此前说过什么”。
- `GENERAL_KNOWLEDGE`：定义、概览、原理、非穷举比较，以及“有哪些知名/代表性作品”这类开放样本。
- `VERIFICATION_REQUIRED`：完整或有界清单、精确年份/地点/数量、易变化事实、明确事实核查或来源要求。

`VERIFICATION_REQUIRED` 编译为 `WEB_RESEARCH`；`GENERAL_KNOWLEDGE` 可以使用 `DIRECT_RESPONSE`，但提示词要求把模型记忆当未核验一般知识，不能为了完整感编造精确细节。分类按问题形态组合信号，不维护作品名或特定问句白名单。

显式 Web 任务还受 `WebResearchPolicy` 限制：查询可以增加同义词，但不能擅自加入排名或最高级；抓取 URL 必须来自用户输入或本轮成功搜索。Policy 决定需要什么证据，Task Contract 决定开放什么能力，Guardrail 在执行前和结束前验证两者。

代码审查和仓库分析都属于 `REPOSITORY_INVESTIGATION`。两者拥有完全相同的权限和循环，差异只有：

```text
CODE_REVIEW          -> finding、严重级别、文件、行号、修复建议
REPOSITORY_ANALYSIS  -> 模块、数据流、证据文件、架构判断、演进建议
```

`PLAN` 不是另一套任务类型，而是叠加在当前契约上的只读操作模式。

## 4. AgentLoop

每轮执行流程：

1. 根据契约过滤 ToolSpec。
2. 根据 Plan 模式再次过滤非只读工具。
3. 构建有预算的上下文。
4. 从 LLM 获取一个 `AgentDecision`。
5. 校验决策是否在本次契约的能力范围内。
6. 执行工具、补丁、命令、只读委派或用户询问。
7. 保存 Decision、Tool Result、Event 和 Checkpoint。
8. 对 `FINAL` 执行本地后置条件检查。
9. 对涉及产品能力的回答执行 Registry 一致性校验。
10. 成功、失败或达到步数上限后结束。

允许的决策包括：

- `PLAN`
- `TOOL_CALL`
- `DELEGATE_READONLY`
- `APPLY_PATCH`
- `RUN_COMMAND`
- `ASK_USER`
- `FINAL`
- `FAILED`

`DIRECT_RESPONSE` 仍通过 AgentLoop 生命周期运行，但使用 `SINGLE_SHOT` 策略：没有本地确定性回答时，AgentLoop 调用文本补全并把结果转换成 `FINAL`。因此简单回答不支付多轮 JSON 决策成本，同时 Session、Guardrail 和结果记录仍保持统一。

`LocalReplyResolver` 只处理可以由本地事实确定的产品元信息、诊断和会话确认；`ArtifactFollowUp` 只解析“上一轮改动在哪里”这类必须绑定紧邻 `FILE_CHANGE` 的状态型追问。它们把确定性答案写入 Task Contract，随后仍经过 AgentLoop 的 Session、Event、Guardrail 和 Final 生命周期，不是绕过 AgentLoop 的另一套问答执行器。对应测试文件只做回归验证，不参与运行时分支。

## 5. 运行时事件与终端显示

AgentLoop 发布版本化的 `AgentRuntimeEvent`，终端 Renderer、`--event-stream` 和 Session Replay 可以消费同一协议。当前产品只实现 CLI 展示，没有额外 Web 控制台。事件覆盖：

- 实际携带的 Conversation 消息数、估算 Token、选择策略、历史截断状态，以及 Prior-response Audit 命中的旧 assistant 消息数。
- Context 构建、Section 选择/跳过/截断和 Session Memory 压缩。
- LLM 调用开始/结束、耗时、Prompt/Completion/Reasoning Token 和 Prompt Cache read/write。
- Tool、Patch、Command 的开始与结果，以及命令 stdout/stderr 实时输出。
- Embedding Cache 的 memory hit、disk hit、miss、write 和 single-flight 合并。
- Guardrail 拒绝、用户询问、Diff 和最终结果。

默认终端把 `[conversation]`、`[context]`、`[memory:session]` 和服务商的 `prompt-cache-*` 分开显示，避免把对话历史、动态 Context 预算和 Prompt/KV Cache 混为一谈。`--verbose` 展开参数与遥测，`--trace` 显示经过脱敏的结构化 Decision、Conversation 角色序列和 Context 分配。服务商没有返回的缓存字段保持 `unreported`，不会把“未知”错误统计为 Miss。

ContextBuilder 构造 Session Memory 时只读取当前 run 之前的记录；当前 run 新产生的 Tool Result、Guardrail 和 Error 已在 AgentState/Recent Evidence 中表达，不会再次作为历史记忆注入。这使同一任务的多步循环不会因为重复读取自己的执行轨迹而不断膨胀。相同输入且已经成功的 Web 调用会被拒绝；provider/transport 已失败时，等价换词搜索也会被拒绝，避免为机械满足错误契约重复等待网络。

事件流不暴露模型隐藏思维链。可观察的“思考”仅指显式 `PLAN`、结构化 `AgentDecision`、工具证据与本地 Guardrail 原因。

## 6. 能力与工具隔离

契约会同时限制“模型看到什么”和“运行时允许什么”：

- Direct 不暴露任何工具，也不会扫描仓库状态。
- Web 只暴露 `web_search` 和 `fetch_url`。
- Repository Investigation 只暴露 `list_files`、`read_file`、`search_code`、`git_status` 和 `git_diff`。
- Knowledge Query 只暴露 `knowledge_search`。
- Repository Task 才能申请补丁、命令、MCP 和委派。

即使模型构造出契约外的 `TOOL_CALL`、`APPLY_PATCH`、`RUN_COMMAND` 或 `DELEGATE_READONLY`，AgentLoop 仍会在执行前拒绝。

MCP 也按契约按需加载。Direct、Web 和只读调查不会启动无关 MCP server。

## 7. 证据和完成性

系统不直接相信模型声称“已经完成”。`TaskGuardrails` 组合两类后置条件：

### 7.1 通用仓库完成条件

- 要求写文件的任务必须存在成功 patch。
- 源码或配置修改必须在最后一次 patch 之后完成对应级别验证。
- 失败的最新验证不能被成功 `FINAL` 忽略。
- 知识库任务必须调用 `knowledge_search` 并保留返回的精确引用。
- 代码审查以及明确要求“完整读取 / 从头到尾分析”的任务，目标文件必须形成从第 1 行到 EOF 的连续读取覆盖；缺行时 `FINAL` 会被拒绝，并给出下一未读行。

### 7.2 契约证据条件

- Repository Investigation 至少成功读取一个相关文件。
- Web Research 正常答案必须成功搜索；如果确实尝试过搜索但 provider/transport 不可用，可以用明确的“来源不足、无法核验”结果完成，不能退回模型记忆冒充搜索结论。
- 实时 Web 事实默认要求两个已抓取来源和两个独立域名。
- “最新模型/版本/发布”等时序最高级不机械要求两个域名；它要求至少两次非等价搜索，其中至少一次带 `官方/official`、release notes、changelog 或 `site:` 约束，并抓取至少一个关键来源。一个权威当前目录可以强于两个陈旧汇总页，但单张搜索结果页不能证明不存在更新发布。
- `web_search` 会先保留 provider 返回的完整候选池，再针对时效查询按实体域名亲和度、可见发布日期、发布页路径和同系列版本号重排，最后才应用 `maxResults`；搜索引擎原始排名不等于发布时间排序。
- Web 搜索分为三层：provider adapter 只负责传输与响应解析；`WebSearchPipeline` 负责跨 provider 的候选归一化、URL 去重、总超时、fallback 和候选池；`WebSearchRanking` 与 `WebResearchPolicy` 负责 provider 无关的召回重排和事实门槛。当前内置 adapter 是 DuckDuckGo HTML/Lite，新增正式 API provider 不应复制后两层。
- 若本轮证据出现高于最终结论的同系列版本候选，Final Guardrail 要求继续核验该候选或明确报告冲突，不能直接声称较低版本“最新”。
- Web 查询必须保持用户范围；用户没有要求排名时，不能把“知名”改成“最知名 / most famous / top / best”。
- `fetch_url` 只能使用用户直接提供或本轮成功搜索返回的精确 URL；猜测来源地址会在执行前被拒绝。
- Web 最终引用必须是本轮搜索或抓取得到的 URL。
- 未达到 Web 门槛时，只允许明确报告证据不足，不能给出确定性实时结论。

## 8. ContextBuilder

上下文按任务阶段和 Token/字符预算选择：

- 用户任务和 Working Set。
- Agent Task Contract。
- Task Completion Contract。
- 最近决策和工具证据。
- 错误诊断、当前 diff 和验证结果。
- 会话上下文、长期记忆、Skills、RAG。
- 必要时的仓库树、README、构建文件和文件放置建议。

Session Memory 使用 `structured-salience-v2` 压缩。候选记录被划分为固定约束与结果、最近对话、执行证据三层，同时受字符和估算 Token 双预算控制。选择过程综合记录类型、显式用户约束、优先级和最近性；重复内容先去重，超长单条记录按 head-tail 裁剪。压缩正文保留 Session Record 来源 id，Context Trace 记录每条保留内容的分层、原因和裁剪状态。自动压缩与显式 `/compact` 共用同一个确定性核心，不依赖额外 LLM 调用。

`read_file` 同时受行数和 Token 预算约束，返回 `hasMore`、`nextStartLine`、`nextStartColumn`、总行数、Token 估算和内容哈希。普通文件按行分页；单行本身超过预算时按列继续读取，因此压缩后的 JSON、生成代码或超长文本也不会成为永远读不完的盲区。`AgentState` 合并同一文件的完整行区间和未完成行位置，并把覆盖率写入紧凑 Checkpoint；源码正文不会复制进 Checkpoint。最新读取块使用独立的高优先级 Context Section，Recent Evidence 只保存范围摘要，避免源码先被截断、随后又重复占用上下文。文件版本变化或成功 patch 会使旧覆盖失效。

完整读取不等于把整个大文件一次塞进模型窗口：Agent 逐块查看源码并继续分页，而运行时负责验证最终覆盖率。普通定点修复仍可使用 `search_code` 后只读相关范围，不强制为无关文件支付全量读取成本。

能力契约也控制隐式上下文读取：Direct 不读取 Git 状态和仓库树；仓库类任务才加载仓库信息。发生错误时，诊断和 diff 的优先级高于稳定的契约说明，保证紧预算下仍能恢复。

## 9. Session、Event 与恢复

- Session JSONL 保存用户消息、决策、工具结果摘要、文件变化、命令结果、摘要和 LLM 用量；大块源码和工具正文不会在 Session/Event 两边完整复制。
- Event JSONL 保存按时间排序的执行事件。
- Checkpoint 保存 Run ID、Working Set、已发生副作用、验证状态和可能的 in-flight action。
- Change Log 保留兼容模式标签，同时写入 `executionEngine: AGENT_LOOP`、`taskKind` 和 `outputKind`。

只读回答和调查会记录 `ASSISTANT_MESSAGE`；仓库修改任务记录 diff 和变更摘要。

`.mini-agent` 目录使用 owner-only 权限（目录 `0700`、文件 `0600`）；Session 与 Event 的共享索引通过文件锁和原子替换更新。JSONL 尾部发生进程中断留下半条记录时，读取会保留此前完整记录；中间损坏仍会明确报错。审计或终端观察者写入失败不会把已经成功发生的补丁/工具副作用伪装成失败并诱发重复执行。

Checkpoint 只在 `sessionId`、运行模式和规范化后的当前目标都一致时恢复。新任务不会继承上一任务的“已写文件/已验证”状态。

## 10. 多轮追问

- 问句型短追问通过 `resolveFollowUpQuestion` 补全省略的主题或谓语。
- 文件位置型短追问优先由 `ArtifactFollowUp` 从紧邻上一轮的 `FILE_CHANGE` 解析，生成确定性回答并跳过 LLM；`FOLLOW_UP_RESOLVED` 同时写入事件审计和终端时间线。
- 写任务由 `TaskDiffService` 使用独立 Git 临时索引捕获任务前后的 Working Tree，生成只属于本轮的 `TASK_DIFF`；任务开始前已经存在的脏改动不会被算入本轮。`TaskDiffStore` 持久化完整变更，终端时间线只渲染可激活的 Changes 卡片，用户激活后才进入 raw-mode 全屏 Diff Viewer。
- “写进去 / 保存一下”通过 `TaskFollowUp` 复用上一轮代码并转换为仓库写入目标。
- “是否写入”由本地 Session 记录确定性回答，不交给模型猜测。
- Conversation 先从完整结构化会话记录中规划最终 prompt：普通请求选择最近历史；普通隐式指代只选择紧邻 exchange，避免旧主题竞争；对助手旧回答的质疑会优先分类为审计请求，并从完整记录召回相关原话、相邻问题和后续纠正。
- `PriorResponseTruthGuard` 只验证“当前记录中是否出现过相关 assistant 输出”。它不会把旧回答当外部事实；否认可见原话时最多重试一次，仍冲突则返回可审计的安全纠正。
- Web 与 Direct 使用同一份 Conversation 选择结果。Web 追问仍必须重新满足本轮 Web 证据门槛，旧回答不能充当来源。

## 11. 扩展原则

新增任务能力时，优先新增可组合元素，而不是新增执行器：

1. 在 `TaskContractBuilder` 中生成契约。
2. 必要时添加工具或 Context Provider。
3. 添加本地 Final Validator。
4. 为契约能力隔离和证据门槛补测试。
5. 继续复用同一个 AgentLoop。

只有当任务具有完全不同的状态机和副作用语义时，才考虑新的 Runtime；单纯输出格式不同不构成拆分执行器的理由。
