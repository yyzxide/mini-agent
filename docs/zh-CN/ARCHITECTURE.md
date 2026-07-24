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
 -> TaskUnderstanding（统一语义记录）
 -> TaskRouter（兼容路由标签，不选择执行器）
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

`TaskUnderstanding` 是本轮语义控制平面的唯一入口。确定性层先提取操作、目标、回答形态、外部事实策略和显式权限信号；高置信度短追问继续由 Follow-up Resolver 补全，遇到条件、复杂否定或间接动作时，`TaskUnderstandingResolver` 再连同可见 Conversation 请求模型返回受 Schema 约束的语义候选。合并层保留“不要修改”“必须联网”“产品/会话事实”等本地硬约束，拒绝模型越过显式只读边界。`TaskRouter` 只把最终记录映射到兼容标签；`TaskContractBuilder`、Context、证据风险评估和回答质量策略继续消费同一份记录。

默认 `AgentTaskContract` 是无工具、无读写、无命令的单步 Direct 契约。CLI、Eval 和其他程序化调用方都必须根据 `TaskUnderstanding` 显式构建契约；遗漏契约不会再退化成拥有仓库写入与命令权限的通用 Agent。

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

### 3.2 ExternalFactPolicy 与声明级升级

外部事实是否进入 Web 不只看“最新/联网”关键词。`ExternalFactPolicy` 先判断证据等级：

- `NOT_EXTERNAL_FACT`：仓库工作、产品元问题、计算、创作和只审计“此前说过什么”。
- `GENERAL_KNOWLEDGE`：定义、概览、原理、非穷举比较，以及“有哪些知名/代表性作品”这类开放样本。
- `VERIFICATION_REQUIRED`：完整或有界清单、精确年份/地点/数量、易变化事实、明确事实核查或来源要求。

`VERIFICATION_REQUIRED` 可以在执行前直接编译为 `WEB_RESEARCH`；`GENERAL_KNOWLEDGE` 可以先使用 `DIRECT_RESPONSE`，但提示词要求把模型记忆当未核验一般知识，不能为了完整感编造精确细节。分类按问题形态组合信号，不维护作品名或特定问句白名单。

前置分类不是不可逆的能力闸门。`EvidenceRiskAssessor` 会在 Direct 草稿发布前审计实际生成的声明，组合检查：

- 有界或序数关系，例如“第三章的对象是谁”“第一个版本是什么”；
- 草稿中的精确日期、版本、数量、位置、发布或获得关系；
- “没有任何、唯一、官方至今没有”等强否定或全称结论；
- “目前、尚未、计划”等时态状态，以及“运行时已到 2026 年却声称仍计划于 2024 年发布”一类确定性日期矛盾；
- 最近会话是否刚发生过事实纠错，而新草稿又继续给出相关精确结论。

命中高风险时，草稿不会写成 assistant answer，也不会作为可用证据进入下一轮 Context。AgentLoop 会把当前契约原地升级为 `WEB_RESEARCH`、扩展研究步数预算并继续执行；若搜索能力不可用，最终只能明确报告证据不足。前置 Policy 因此是节省成本的风险先验，草稿声明审计才是覆盖路由漏判的第二道防线。普通定义、原理说明、产品元信息、仓库事实、可推导计算和对旧错误的明确撤回不会因这套审计自动联网。

显式 Web 任务还受 `WebResearchPolicy` 限制：查询可以增加同义词，但不能擅自加入排名或最高级；抓取 URL 必须来自用户输入或本轮成功搜索。Policy 决定需要什么证据，Task Contract 决定开放什么能力，Guardrail 在执行前和结束前验证两者。

### 3.3 AnswerQualityPolicy

证据充分只表示“允许回答”，不表示答案已经有用。`AnswerQualityPolicy` 独立识别定义、数量、枚举、有界关系、身份、解释和一般回答，并把用户明确要求的简短、均衡或详细深度编译进 Task Contract。

- 定义题先直接定义，再补充用途、特征或必要区别。
- 数量题必须给出受证据支持的数字；如果没有稳定数字，要解释定义、统计范围、时间点或披露限制，不能拿相邻类别替代用户要求的类别。
- 枚举题使用可读列表，并说明是完整清单、代表样本还是受证据限制。
- 有界关系先回答指定范围；当“最终对象”和“范围内全部对象”可能混淆时要主动区分。
- 解释题给出因果或工作链路，而不只重复结论。

非确定性自然语言 `FINAL` 还会经过回答形态 Guardrail：它会拒绝只有来源链接、没有实质内容的答案，以及没有回答数量、定义或枚举形态的结果。本地能力注册表、文件变更记录等确定性答案不重复套用语言表面规则。这里不设置机械最低字数：一句准确的实体答案可以成立，长篇但没有回答问题仍会被拒绝。

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
6. 执行工具、补丁、命令、多 Agent 委派或用户询问。
7. 保存 Decision、Tool Result、Event 和 Checkpoint。
8. 对 `FINAL` 执行本地后置条件检查。
9. 对涉及产品能力的回答执行 Registry 一致性校验。
10. 成功、失败或达到步数上限后结束。

允许的决策包括：

- `PLAN`
- `TOOL_CALL`
- `DELEGATE`
- `APPLY_DELEGATED_PATCH`
- `APPLY_PATCH`
- `RUN_COMMAND`
- `ASK_USER`
- `FINAL`
- `FAILED`

`DIRECT_RESPONSE` 仍通过 AgentLoop 生命周期运行，但先使用 `SINGLE_SHOT` 策略：没有本地确定性回答时，AgentLoop 调用文本补全并生成候选 `FINAL`。低证据风险草稿直接完成，因此简单回答不支付多轮 JSON 决策成本；高风险草稿由 `EvidenceRiskAssessor` 扣留，并在同一 State、Session、事件流和完成生命周期中动态升级为迭代式 Web 契约。

`LocalReplyResolver` 只处理可以由本地事实确定的产品元信息、诊断和会话确认；`ArtifactFollowUp` 只解析“上一轮改动在哪里”这类必须绑定紧邻 `FILE_CHANGE` 的状态型追问。它们把确定性答案写入 Task Contract，随后仍经过 AgentLoop 的 Session、Event、Guardrail 和 Final 生命周期，不是绕过 AgentLoop 的另一套问答执行器。对应测试文件只做回归验证，不参与运行时分支。

## 5. 运行时事件与终端显示

AgentLoop 发布版本化的 `AgentRuntimeEvent`，终端 Renderer、`--event-stream` 和 Session Replay 可以消费同一协议。当前产品只实现 CLI 展示，没有额外 Web 控制台。事件覆盖：

- 实际携带的 Conversation 消息数、估算 Token、选择策略、历史截断状态，以及 Prior-response Audit 命中的旧 assistant 消息数。
- Context 构建、Section 选择/跳过/截断和 Session Memory 压缩。
- LLM 调用开始/结束、耗时、Prompt/Completion/Reasoning Token 和 Prompt Cache read/write。
- Tool、Patch、Command 的开始与结果，以及命令 stdout/stderr 实时输出。
- Embedding Cache 的 memory hit、disk hit、miss、write 和 single-flight 合并。
- Guardrail 拒绝、用户询问、Diff 和最终结果。
- 子 Agent 的角色、访问协议、依赖关系、逐步模型决策摘要、工具调用、协议恢复、精确失败原因、完成状态和提案涉及的文件。

默认终端把 `[conversation]`、`[context]`、`[memory:session]` 和服务商的 `prompt-cache-*` 分开显示，避免把对话历史、动态 Context 预算和 Prompt/KV Cache 混为一谈。`--verbose` 展开参数与遥测，`--trace` 显示经过脱敏的结构化 Decision、Conversation 角色序列和 Context 分配。服务商没有返回的缓存字段保持 `unreported`，不会把“未知”错误统计为 Miss。

ContextBuilder 构造 Session Memory 时只读取当前 run 之前的记录；当前 run 新产生的 Tool Result、Guardrail 和 Error 已在 AgentState/Recent Evidence 中表达，不会再次作为历史记忆注入。这使同一任务的多步循环不会因为重复读取自己的执行轨迹而不断膨胀。相同输入且已经成功的 Web 调用会被拒绝；provider/transport 已失败时，等价换词搜索也会被拒绝，避免为机械满足错误契约重复等待网络。

事件流不暴露或持久化模型隐藏思维链。服务商返回 `reasoning_tokens` 或私有 `reasoning_content` 时，只记录 Token 数与“私有推理字段可用”这一布尔事实；Direct 回答不会把 `reasoning_content` 当作正文输出。默认模式只在 `[llm]` 和汇总中保留 reasoning Token，`--verbose` 才显示简短的私有字段可用状态，`--trace` 才补充不展示原始思维链的策略说明。可观察的“思考”由显式 `PLAN`、每次 Tool Call 的简短 `reason`、结构化 `AgentDecision`、工具证据、协议恢复和本地 Guardrail 原因组成。

## 6. 能力与工具隔离

契约会同时限制“模型看到什么”和“运行时允许什么”：

- Direct 不暴露任何工具，也不会扫描仓库状态。
- Web 只暴露 `web_search` 和 `fetch_url`。
- Repository Investigation 只暴露 `list_files`、`read_file`、`search_code`、`git_status` 和 `git_diff`。
- Knowledge Query 只暴露 `knowledge_search`。
- Repository Task 才能申请补丁、命令、MCP 和写入型委派；Repository Investigation 可以使用只读委派。

即使模型构造出契约外的 `TOOL_CALL`、`APPLY_PATCH`、`APPLY_DELEGATED_PATCH`、`RUN_COMMAND` 或 `DELEGATE`，AgentLoop 仍会在执行前拒绝。

## 6.1 多 Agent 协作边界

多 Agent 是默认可用的仓库能力，不依赖 `--agents` 才能开启。`SubAgentIntent` 区分能力询问、明确委派、明确禁用与自动选择；用户说“用两个 subagent，一个写、一个 review”时，Task Contract 会把实际委派设为完成条件。普通复杂仓库任务仍由主 Agent 判断拆分是否有收益。

`DELEGATE` 子任务有三种访问协议：

- `READ_ONLY`：并行调查仓库事实。
- `PROPOSE_CHANGES`：实现型子 Agent 获得一次性可写 worktree，在其中应用补丁、运行受限的构建/测试并迭代修复，最后返回相对私有基线的 unified diff；它不能直接修改主工作区。
- `REVIEW_CHANGES`：依赖一个或多个前序任务，读取仓库并审查其补丁提案。

依赖图按波次执行：无依赖任务可以并行，reviewer 只会在 writer 成功后运行。Git 仓库使用 detached 临时 worktree，并把父工作区当时的 tracked、staged 和非忽略 untracked 状态覆盖后提交为私有基线；非 Git 测试夹具使用初始化 Git 的隔离副本。reviewer 会在自己的工作区物化依赖补丁，因此能读取补丁后的真实文件和 diff。

writer 的 `RUN_COMMAND` 只允许结构化、无 Shell、无安装和无网络的验证命令，例如测试、类型检查、Lint 和 Build。失败结果回到子循环供其继续修复；最终 proposal 记录验证命令、结果、工作区类型和基线指纹。所有子输出仍是不可信证据，只有主 Agent 可以发出 `APPLY_DELEGATED_PATCH`。

父级合入前重新计算工作区指纹。若父工作区在子任务运行期间发生变化，补丁必须重新通过 `git apply --check`；无法干净应用时返回 `DELEGATED_PATCH_CONFLICT` 并要求基于新基线重新委派，不会覆盖用户或其他 Agent 的并发修改。合入后仍走 PatchManager、权限、变更记录和父级验证门禁。

实现型子 Agent 修改或删除已有文件前必须先获得成功的仓库读取证据；只创建独立新文件时可以直接在隔离工作区应用补丁，避免为了形式要求读取无关文件。LLM 返回非法 JSON、空响应或常见 Decision Schema 漂移时，协调器会在共享预算内做有界协议恢复，并把原始错误和恢复动作发布到终端事件流。

当用户明确指定“由 subagent 实现”时，主 Agent 在委派补丁成功合入前不能用普通 `APPLY_PATCH` 代写。若允许的委派批次已经耗尽且 writer 或明确要求的 reviewer 仍未成功，运行立即以 `REQUIRED_DELEGATION_EXHAUSTED` 结束，保留子任务精确错误，不再继续消耗父级 Step 或通过代写制造虚假成功。

旧会话中的 `DELEGATE_READONLY` 仍可恢复和执行，但它只是持久化协议兼容入口，不再出现在模型的主协议中。

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
- Direct 候选答案在发布前经过声明级证据风险审计；升级事件记录为 `DIRECT_DRAFT_EVIDENCE_ESCALATION`，被扣留草稿不会进入实时 Context 或对话历史。
- 实时、精确数量、精确属性、完整枚举、有界关系和纠错敏感事实默认要求两个已抓取来源和两个独立域名；时序最高级按下面的权威证据链单独处理。
- “最新模型/版本/发布”等时序最高级不机械要求两个域名；它要求至少两次非等价搜索，并建立“权威时效查询 → 该查询返回的站内候选 → 精确 URL 抓取 → 页面中可见的版本、日期、发布或当前状态”证据链。`site:` 查询中的当前或相邻年份可以表达时效检索意图，但年份和搜索排名本身都不是事实证明。一个闭环的权威当前目录可以强于两个陈旧汇总页。
- `WebResearchProgress` 在每次决策前确定性计算 DISCOVER、AUTHORITY_SEARCH、INSPECT_SOURCE、COMPARE_EVIDENCE、SYNTHESIZE 阶段，展示搜索视角、来源抓取、域名、权威血缘、时效正文、引用数量、剩余决策和唯一推荐动作。最新类任务完成一次普通召回后，下一次搜索必须转向官方时效检索。
- Web Research 默认最多 14 次决策，其中最后 2 次保留给最终综合。进入 SYNTHESIZE 后模型看不到 Web tools，运行时也拒绝 TOOL_CALL、PLAN 和 ASK_USER；证据充分时输出带引用的成功答案，否则输出明确的失败或证据不足结论。
- `web_search` 会先保留 provider 返回的完整候选池，再针对时效查询按实体域名亲和度、可见发布日期、发布页路径和同系列版本号重排，最后才应用 `maxResults`；搜索引擎原始排名不等于发布时间排序。
- Web 搜索分为三层：provider adapter 只负责传输与响应解析；`WebSearchPipeline` 负责跨 provider 的候选归一化、URL 去重、总超时、fallback 和候选池；`WebSearchRanking` 与 `WebResearchPolicy` 负责 provider 无关的召回重排和事实门槛。当前内置 adapter 是 DuckDuckGo HTML/Lite，新增正式 API provider 不应复制后两层。
- 若本轮证据出现高于最终结论的同系列版本候选，Final Guardrail 要求继续核验该候选或明确报告冲突，不能直接声称较低版本“最新”。
- Web 查询必须保持用户范围；用户没有要求排名时，不能把“知名”改成“最知名 / most famous / top / best”。
- `fetch_url` 只能使用用户直接提供或本轮成功搜索返回的精确 URL；猜测来源地址会在执行前被拒绝。非 2xx 响应，以及 WAF、验证码、安全验证、访问拒绝和登录壳即使返回 HTTP 200，也不能计为成功正文。
- Web 最终至少引用一个本轮真正抓取并检查过的 URL；只出现在搜索结果中、没有读取正文的候选不能冒充已检查来源。
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
- Web 与 Direct 使用同一份 Conversation 选择结果。短追问先补全省略的数量、枚举、赛事或属性谓词，再以补全后的问题重建同类型 Task Contract；因此“360”继承“有多少子公司”时，也会继承数量型回答要求和来源门槛。Web 追问仍必须重新满足本轮 Web 证据门槛，旧回答不能充当来源。

## 11. 扩展原则

新增任务能力时，优先新增可组合元素，而不是新增执行器：

1. 在 `TaskContractBuilder` 中生成契约。
2. 必要时添加工具或 Context Provider。
3. 添加本地 Final Validator。
4. 为契约能力隔离和证据门槛补测试。
5. 继续复用同一个 AgentLoop。

只有当任务具有完全不同的状态机和副作用语义时，才考虑新的 Runtime；单纯输出格式不同不构成拆分执行器的理由。
