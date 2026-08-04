# 项目现状

> 最近核对：2026-08-03。本文只记录能够由当前源码、确定性门禁和手工审计支持的结论。

本文描述 `mini-coding-agent` 当前能够被代码和测试证明的能力、适合的项目定位，以及仍然存在的工程边界。

它不再使用百分制自评。主观高分无法证明可靠性，反而会掩盖真实的设计取舍。面试或项目介绍应引用具体能力、测试、演示和限制。

## 一句话定位

`mini-coding-agent` 是一个本地运行、可审计、由 AI TaskFrame 驱动并由确定性安全内核约束的 AI Coding Agent CLI。它重点解决自然语言任务理解、最小权限工具执行、上下文治理、证据完成性、仓库变更和隔离式多 Agent 协作。

当前成熟度可以描述为：

- 作品级、高完成度工程原型；
- 适合简历、架构讲解和现场演示；
- 核心闭环完整，但不是生产级商业 Coding Agent。

## 当前验证基线

截至 2026-08-03，仓库把 `pnpm verify` 作为唯一确定性验证基线。它依次执行：

- 从 `src/cli/index.ts` 建立 TypeScript import graph，拒绝不可达源码和无法解析的本地 import，并禁止已删除控制面文件或旧模式标识在迁移边界之外重新出现；
- 检查源码导出是否至少被源码或测试引用，防止“文件可达但旧接口无人使用”；
- 校验 README 与 `docs/` 中的本地链接和源码路径引用；
- 清空 `dist/` 后重新执行 TypeScript 构建，校验 shebang 并在 POSIX 平台恢复 `dist/cli/index.js` 的可执行位，避免旧编译产物或不可启动的 CLI 伪装成成功构建；
- 通过真实可执行入口运行 `dist/cli/index.js --version`，并核对输出与 `package.json` 版本一致；
- 运行版本化的确定性 AgentBench，并与 baseline 比较；
- 开启 `noUnusedLocals` / `noUnusedParameters` 检查；
- 运行完整 Vitest 测试集。

GitHub Actions 在 `main` 的 push 和 pull request 上运行同一个 `pnpm verify`，避免本地与 CI 漂移。2026-08-03 在非受限子进程环境执行的完整门禁通过；测试数量不再写死在长期文档中，它会随删除重复用例或增加结构型回归而变化，实际结果以当次命令输出为准。项目固定使用 pnpm，但 package script 内部直接调用 Node、TypeScript 和 Vitest，不再嵌套 npm/pnpm；因此从 `pnpm` 或 `corepack pnpm` 进入时都不会继承另一种包管理器的私有配置并产生误导性警告。

### 本轮代码审计结论

- import graph 中没有不可达 TypeScript 源文件，导出检查没有发现无人引用的源码声明；现有 `commander`、`execa`、`zod` 及开发依赖都有实际用途。
- strict TypeScript、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、未使用声明检查、clean build、CLI 烟雾测试、AgentBench 和完整测试均通过。
- MCP stdio 用例在受限执行沙箱中会因嵌套 Node 子进程 I/O 被环境截断而假失败；同一用例和完整测试在正常子进程环境通过。这是测试环境边界，不应通过修改 MCP 协议代码掩盖。
- 没有发现需要直接删除的旧执行器或重复控制面。源码中的旧标签和旧配置路径只存在于明确的持久化迁移边界，并由架构检查限制。
- 当前主要代码风险是维护性而非已复现的功能错误：`src/cli/index.ts` 与 `src/agent/AgentLoop.ts` 仍然较大。继续拆分应以形成稳定职责边界和回归收益为前提，不能为了行数重写核心控制面。

## 已完成的核心闭环

### 1. 单一 AgentLoop

运行时不再先把请求划入 Direct、Web、Review 或 Edit 模式。每个 CLI 请求都以 `AGENT_TASK` 进入同一个 `AgentLoop`，任务差异由 `TaskFrame` 和当前效果授权表达：

- 用户目标和目标范围；
- 是否需要回答、读写仓库、执行命令、访问 Web、知识库或委派；
- 显式只读、禁网、禁命令等约束；
- 验证强度和完成条件；
- 当前已经授权的最小能力与已获得的证据。

模型选择 `web_search`、`read_file`、`APPLY_PATCH`、`RUN_COMMAND` 或某个 MCP Tool 时，`CapabilityNegotiator` 在同一个 State、Session 和事件流中申请并组合能力，`kind` 始终保持 `AGENT_TASK`。CLI、程序化 `AgentLoop` 和 AgentHarness 使用同一条 TaskFrame 执行链。旧 Session 中的结果字符串只用于持久化数据兼容，不对应另一套执行器。

Capability Registry 的 `tools` 与 `actions` 已物理分离：`TOOL_CALL` 只会看到真实注册工具，`APPLY_PATCH` / `RUN_COMMAND` 等只作为顶层 Decision 动作出现。运行时也会对遗留的 `TOOL_CALL run_command` / `TOOL_CALL apply_patch` 返回精确的 `DECISION_ACTION_REQUIRED`，而不是模糊的 `TOOL_NOT_FOUND`。

Registry 还统一登记 `surfaces`，因此没有静态 Tool 名称的 Session、长期记忆、Skills、AgentBench，以及动态命名的 MCP Tool Runtime 也能进入同一产品事实清单。产品能力问答由 TaskFrame 模型输出结构化 `productCapability.act/capabilityIds`，再由本地 Registry 生成；运行时已经删除对“联网、写文件、子代理”等回答文本的专项正则扫描。

### 2. AI TaskFrame 任务理解

`TaskFrame` 是唯一语义记录。`TaskFrameResolver` 让模型结合原始请求和 Conversation 返回受 Zod Schema 约束的目标、效果、Web 证据策略、约束、验证等级和完成条件。CLI 不通过问句关键词决定能否读取文件、联网或修改代码。

运行边界如下：

- 模型负责解释目标和选择下一步动作，本地代码负责授权与执行；
- 显式只读、禁网、禁命令约束不能被后续模型动作突破；
- 写入、命令、Web 和委派是可组合效果，不是需要切换的互斥模式；
- 模型填写的最近消息数、代理数等资源偏好会收敛到本地边界，不会因非关键越界丢弃整份任务语义；
- 非法 JSON 或 Schema 会先触发一次带精确错误的模型自修；仍不可用时 AgentLoop 会在任何动作或工具之前以 `TASK_FRAME_UNRESOLVED` 失败，不退回正则自然语言路由，也不拿猜测合同继续执行；
- Completion Contract 消费 TaskFrame 和实际证据，不在结束阶段重新猜测原始问句；
- 路径沙箱、危险命令、Patch 检查、权限确认和验证时序仍由确定性内核掌控。

旧 Router、TaskUnderstanding、TaskContractBuilder、LocalReply、专用 Follow-up/Artifact 解析器、外部事实问句策略、Repo 预扫描器和只读委派别名已经从源码物理删除。配置中也不再公开控制面开关；加载旧配置时只会丢弃旧字段。`check:architecture` 不仅阻止新的不可达源码，还会拒绝恢复这些旧文件，并限制旧持久化标签只能出现在明确的数据迁移边界。

能力协商接口也不再接收原始 `userGoal`：它只消费已验证 Task Contract、模型的结构化 Decision 和工具元数据。显式 `/compact` 的兼容压缩层不再按中英文“必须/不要/must”等词判断约束；当前约束只来自 TaskFrame 的结构化字段。

### 3. 可验证的仓库执行

仓库任务支持：

- 安全列目录、搜索和分页读文件；
- 过大的 `read_file` 分页提示自动收敛，真实 Schema 错误返回具体字段；
- 完整文件覆盖率追踪；
- unified diff 检查与应用；
- 占位/无变化 Patch 的 `PATCH_NO_CHANGES` 语义诊断，不把空补丁误报为 Git 上下文损坏；
- 结构化命令执行和实时输出；
- 验证强度分级；
- 文件类型感知的内置 `verify_file`（HTML/JSON/classic JavaScript）以及命令验证器目标兼容检查；
- 验证来源区分 `TASK_INFERRED` 与 `USER_REQUIRED`：前者根据实际变更文件收敛到可执行等级，后者保持用户明确要求；
- 最新补丁之后的验证时序检查；
- 任务级 before/after diff；
- 新文件与文档变更记录；
- 中断 checkpoint 与恢复。

成功 `FINAL` 不是模型单方面决定。运行时会检查 `REQUIRED` 修改是否真的落盘、条件修改是否已有调查证据、证据是否覆盖目标、测试是否相关且发生在最新补丁之后。

重复保护不仅覆盖连续相同 Decision，也覆盖没有新增完成证据时交替复现的 Guardrail 环，避免两个错误分支互相切换直到耗尽 `maxSteps`。

### 4. 隔离式多 Agent 协作

多 Agent 在仓库任务中默认可用，但不强制每轮使用。自然语言可以表达自动选择、明确委派或明确禁用。

- 调查型子 Agent 使用只读工作区。
- Writer 获得一次性 Git worktree，在隔离环境中修改文件、运行受限验证、继续修复并生成补丁。
- Reviewer 在自己的工作区物化依赖补丁，审查修改后的真实文件。
- 主 Agent 独占父工作区合入权。
- 子任务携带父级基线指纹；父工作区变化后会重新校验补丁。
- 冲突返回 `DELEGATED_PATCH_CONFLICT`，不会覆盖并发修改。
- worktree 在成功、失败和异常路径都会清理。

Writer 的命令允许列表是应用层控制，不等同于容器或操作系统级强沙箱。

### 5. Context、Conversation 与 Memory

系统明确区分：

- Conversation：用户和助手可见对话；
- Context：当前任务从多种来源选择的模型输入；
- Session Memory：当前 Session 中经过结构化压缩的记录；
- Long-term Memory：受写入/读取策略控制的偏好、约定、决策和已验证结果；
- Prompt Cache：模型服务商报告的输入 Token 复用；
- Embedding Cache：本地检索向量缓存。

Context 使用字符与 Token 双预算，并记录选中、裁剪和排除原因。运行时先用中性的最近消息窗口构建 TaskFrame；当模型声明需要旧陈述、决策、产物、约束或话题证据时，由 `TaskFrame.conversationEvidence.queries` 从完整 Session 中选择有界语义匹配及其相邻上下文。

历史助手消息与执行事实分开保存：助手消息说明上一轮输出了什么，`AGENT_CHECKPOINT` / `FILE_CHANGE` 说明上一轮是否真的修改仓库以及修改了哪些文件。后续 TaskFrame 和 AgentDecision 会同时看到运行时生成的只读执行账本；若文字与账本冲突，以真实 Patch 证据为准。因此“仓库里原本就有这个文件”或“本轮读取了它”不能被解释成“本轮创建了它”。

### 6. Web 证据闭环

Web Research 支持查询范围守恒、搜索、抓取、来源血缘、时效候选比较、任务相关证据阈值和引用白名单。

模型只向 `TaskFrame.webEvidencePolicy` 写入 `ORDINARY / CORROBORATED / CURRENT / HIGH_STAKES` 语义等级、依据和 `REPRESENTATIVE / SUPERLATIVE` 查询范围。本地策略表统一映射搜索视角、抓取数、独立域名、引用、时效与权威来源要求；模型不能用任意数值放大硬性后置条件，Guardrail 也不从原始问句正则推断“最新版任务”或“排名任务”。

已处理的典型失败包括：

- 搜索传输失败后反复改写同义查询；
- 猜测可能存在的官方 URL；
- 搜索成功但抓取证据不足；
- 普通联网请求被错误升级成严格多域名核验；
- 搜索排名被误当成时间排序；
- Guardrail 只拒绝、不告诉 Agent 下一步；
- 接近步数上限时继续调用工具而没有预留综合回答。

最终综合预留现在具有确定性降级终止：普通任务已有公开候选时交付带限制的部分答案，严格任务证据不足时交付 `success=false` 的限制性总结，两者都不会继续消耗步骤。`fetch_url` 同时支持从 HTTP 或 HTML meta 识别旧中文字符集。

底层搜索服务的召回质量仍然会影响结果。正式 Search API 可以提升稳定性，但不能自动绕过来源页 403；Agent 可以改善查询、证据选择和诚实降级，但无法从未召回或不可读取的页面中恢复事实。

### 7. 可观察性与本地审计

终端时间线和版本化 `AgentRuntimeEvent` 覆盖：

- Conversation 和 Context；
- 显式计划和结构化 Decision；
- LLM Token、reasoning Token 和 Prompt Cache 指标；
- 工具输入、结果和耗时；
- Patch、命令实时输出与验证；
- 子 Agent worktree、文件、命令和协议恢复；
- Guardrail 原因；
- Changes 卡片与 Diff Viewer；
- Session、Checkpoint、runtime log 和 change log。

系统不显示隐藏思维链。可审计性来自计划、行动理由、结构化决策、工具证据和本地规则，而不是泄露私有推理文本。

### 8. 扩展能力

当前还实现了：

- 声明式 `SKILL.md` 发现、全量有界目录、语义选择，以及通过 `skill_read` 对完整指令和随附文本资源进行渐进读取；
- 真正只读的 Plan 模式；
- MCP stdio / Streamable HTTP runtime：远端 tools 独立注册，静态 resources/list/read 与 prompts/list/get 通过只读命名空间适配器进入统一 Tool Registry，并保留初始化协商元数据用于兼容诊断；
- repository-local 文档、源码与配置文本 RAG；Agent 能以 `knowledge_search -> knowledge_index -> knowledge_search` 自主恢复空索引；
- 本地/远程 Embedding 与缓存；
- AgentBench 脚本化和真实模型评测入口；
- Capability Registry 与产品能力事实校验；
- 环境诊断、日志和 Session 调试命令。

这些能力共享现有权限系统，不能绕过 Task Contract。版本化确定性 AgentBench 当前包含 10 个核心场景，并已纳入“旧文件不是本轮产物”“修改未跟踪 HTML”“拒绝无变化 Patch 后恢复”等历史故障；`verify_file` 的成功结果也与命令验证使用同一评测指标口径。

## 当前真实短板

### 模型与评测

- 真实模型评测已支持重复采样、首轮成功率、至少一次成功率、全轮通过率、flaky 场景数、run pass rate 的 95% Wilson 区间、成本/延迟与失败分类，并可保存报告后离线比较；版本化 `real-model-acceptance-v1` 固定检查陈旧 RAG 恢复、Skill 渐进读取和旧文件产物溯源，`bench accept` 同时输出 JSON 与 Markdown。当前仍未积累足够大的公开真实模型样本。
- 自动化测试主要证明运行时确定性，不代表所有模型都能稳定规划。
- TaskFrame 和动作选择仍依赖模型质量；语义编译器不可用时 AgentLoop 会明确失败，因此不会误执行，但也不能在模型服务中断时完成任务。
- 已具备报告持久化、可读验收报告与 `bench compare` 结构化差值入口；真实调用结果默认写入 `.mini-agent/bench` 而不提交仓库，因为它们依赖个人凭据、成本和外部服务波动。

### 语义与控制边界

- 多 Agent 要求进入 `TaskFrame.collaboration`，长会话取证进入 `TaskFrame.conversationEvidence`，Web 时效要求进入 `TaskFrame.webEvidencePolicy`。
- 系统使用中性的最近窗口解析 TaskFrame，再根据模型给出的语义查询从完整 Session 有界召回历史消息和相邻上下文；它不是向量检索。
- 产品元事实冲突、危险命令、路径、URL 血缘和 Memory 证据过滤仍有确定性规则；是否属于产品问题、是否召回历史记忆以及需要哪些能力只消费 TaskFrame，不再由这些规则选择 Direct/Web/Edit。
- 配置中的 MCP Tool、resource reader 和 prompt reader 可被模型逐个发现和申请；授权精确到 `<server>__<tool>` / `<server>__read_resource` / `<server>__get_prompt`，不会隐式获得整个 Server、仓库写入或命令能力。Plan/固定只读只开放安全只读 MCP，修改型外部调用仍需逐次显式批准；程序化调用若没有提供权限管理器会直接失败，不存在 fail-open 旁路。Resource 与 Prompt 内容始终标记为不可信外部数据，不能提升为系统指令。

### 安全与隔离

- 命令、工具和子 Agent worktree 是应用层隔离，不是强安全沙箱。
- 运行仓库自带的测试脚本仍需信任该仓库。
- MCP Server 属于外部进程或服务，其权限边界取决于配置和运行环境。

### Web 与外部系统

- Web Search Provider 顺序可配置；默认使用免凭据的 DuckDuckGo HTML/Lite，也可配置 Brave Search API。`doctor` 会显示实际顺序并诊断缺少的 Brave 凭据；真实联网质量仍取决于 API 配额、网络和来源页面。
- 没有专业体育、金融、新闻等垂直实时 API。
- 严格 Web 终局已经要求结构化 `webClaims`，本地验证每条映射引用本轮成功抓取的精确 URL，并要求结论和来源在最终摘要中可见；这完成了可审计的 claim-source 关联，但尚未实现基于 NLI/LLM Judge 的逐条语义蕴含核验。
- `fetch_url` 会拒绝 HTTP 200 的 WAF/CAPTCHA、登录壳、空正文和高置信软 404；无正文 SPA、订阅墙和站点特有错误模板仍可能需要更多适配。
- MCP 初始化结果会保留协议版本、服务端信息与 capability keys；tools、resources、prompts 的 list 调用会持续跟随 `nextCursor`，并拒绝重复 cursor 或超过有界页数。状态诊断分别显示发现数量、注册适配器、已桥接/未桥接能力和逐 capability 错误；某一 list 失败只进入 degraded 状态，不会移除同一 Server 已成功加载的其他能力。
- MCP 已覆盖静态 resources/list/read 与 prompts/list/get，但未覆盖 resource templates、订阅、completion、认证和服务端主动请求场景。
- MCP Runtime 对应 `2025-11-25` 的 initialize/session 形态，尚未兼容正式 `2026-07-28` 无状态 core、`server/discover`、每请求 `_meta`、InputRequiredResult 和扩展机制。

### 产品化

- CLI 是主要产品界面，没有 IDE 集成、Web 控制台或持续式全屏 TUI。
- 本地 JSONL、RAG 跨进程写锁和原子替换适合单机 CLI；它们能避免并发索引更新丢失，但不替代多租户服务需要的数据库事务、ACL 和高可用。
- 配置 profile、版本发布、安装分发和跨平台现场验证仍可继续打磨。
- `src/cli/index.ts` 与 `src/agent/AgentLoop.ts` 仍是较大的编排模块；职责已比旧版本清晰，但修改时需要更高的回归成本。

## 面试项目竞争力

相对普通 LLM API Demo，本项目的差异不在功能数量，而在可以解释并演示以下工程问题：

1. 模型为什么不能直接决定权限和成功状态；
2. 不同任务如何在同一循环中获得不同能力；
3. 上下文如何选择、压缩和追踪来源；
4. 子 Agent 如何隔离修改、验证、Review 和安全合入；
5. Web 搜索失败时如何避免猜测与死循环；
6. 如何用结构化事件、Session 和测试重现问题。

适合作为 AI 应用、Agent/Workflow、DevTools、平台工程或偏后端岗位的技术亮点项目。若用于更高级的 Agent 基础设施岗位，还需要生产部署、真实任务指标、强沙箱和多租户经验。

## 现在应该停止做什么

为了面试展示，不应继续无限扩张：

- 不为单个问句增加硬编码回复；
- 不为了测试数量堆叠重复用例；
- 不在没有真实需求时增加更多 Agent 角色；
- 不把 Web UI、IDE 插件或容器平台当作当前必做项；
- 不用“生产级”“完全对标”“任意任务稳定完成”描述项目。

当前最高收益工作是保持文档真实、准备三组稳定演示，并用少量代表性 benchmark 证明关键边界。
