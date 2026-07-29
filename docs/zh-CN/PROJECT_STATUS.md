# 项目现状

本文描述 `mini-coding-agent` 当前能够被代码和测试证明的能力、适合的项目定位，以及仍然存在的工程边界。

它不再使用百分制自评。主观高分无法证明可靠性，反而会掩盖真实的设计取舍。面试或项目介绍应引用具体能力、测试、演示和限制。

## 一句话定位

`mini-coding-agent` 是一个本地运行、可审计、由 AI TaskFrame 驱动并由确定性安全内核约束的 AI Coding Agent CLI。它重点解决自然语言任务理解、最小权限工具执行、上下文治理、证据完成性、仓库变更和隔离式多 Agent 协作。

当前成熟度可以描述为：

- 作品级、高完成度工程原型；
- 适合简历、架构讲解和现场演示；
- 核心闭环完整，但不是生产级商业 Coding Agent。

## 当前验证基线

截至 2026-07-28，本地确定性验证基线为：

- 62 个 Vitest 测试文件；
- 510 个自动化测试；
- `npm test -- --run` 实际运行全部通过；
- TypeScript 构建通过；
- `noUnusedLocals` / `noUnusedParameters` 检查通过；
- `git diff --check` 通过；
- GitHub Actions 在 `main` 的 push 和 pull request 上执行安装、构建与测试。

测试数量相比迁移前减少，是因为删除了旧 Router、TaskUnderstanding、LocalReply 及双控制面专用测试，并把旧 CLI 回归替换为单控制链架构回归。更重要的是覆盖范围包含权限边界、失败路径和端到端 AgentLoop，而不只是工具函数。

## 已完成的核心闭环

### 1. 单一 AgentLoop

运行时不再先把请求划入 Direct、Web、Review 或 Edit 模式。每个 CLI 请求都以 `AGENT_TASK` 进入同一个 `AgentLoop`，任务差异由 `TaskFrame` 和当前效果授权表达：

- 用户目标和目标范围；
- 是否需要回答、读写仓库、执行命令、访问 Web、知识库或委派；
- 显式只读、禁网、禁命令等约束；
- 验证强度和完成条件；
- 当前已经授权的最小能力与已获得的证据。

模型选择 `web_search`、`read_file`、`APPLY_PATCH`、`RUN_COMMAND` 或某个 MCP Tool 时，`CapabilityNegotiator` 在同一个 State、Session 和事件流中申请并组合能力，`kind` 始终保持 `AGENT_TASK`。CLI、程序化 `AgentLoop` 和 AgentHarness 使用同一条 TaskFrame 执行链。旧 Session 中的结果字符串只用于持久化数据兼容，不对应另一套执行器。

### 2. AI TaskFrame 任务理解

`TaskFrame` 是唯一语义记录。`TaskFrameResolver` 让模型结合原始请求和 Conversation 返回受 Zod Schema 约束的目标、效果、Web 证据策略、约束、验证等级和完成条件。CLI 不通过问句关键词决定能否读取文件、联网或修改代码。

运行边界如下：

- 模型负责解释目标和选择下一步动作，本地代码负责授权与执行；
- 显式只读、禁网、禁命令约束不能被后续模型动作突破；
- 写入、命令、Web 和委派是可组合效果，不是需要切换的互斥模式；
- 非法 JSON 或不可用的 TaskFrame 使用中性自适应 fallback，不退回正则自然语言路由；
- Completion Contract 消费 TaskFrame 和实际证据，不在结束阶段重新猜测原始问句；
- 路径沙箱、危险命令、Patch 检查、权限确认和验证时序仍由确定性内核掌控。

旧 `TaskUnderstanding`、`TaskUnderstandingResolver`、`TaskRouter`、`TaskContractBuilder`、`LegacyControlPlane` 和本地固定问句回复器已经从源码物理删除。配置中也不再公开控制面开关；加载旧配置时只会丢弃旧字段。

### 3. 可验证的仓库执行

仓库任务支持：

- 安全列目录、搜索和分页读文件；
- 过大的 `read_file` 分页提示自动收敛，真实 Schema 错误返回具体字段；
- 完整文件覆盖率追踪；
- unified diff 检查与应用；
- 结构化命令执行和实时输出；
- 验证强度分级；
- 最新补丁之后的验证时序检查；
- 任务级 before/after diff；
- 新文件与文档变更记录；
- 中断 checkpoint 与恢复。

成功 `FINAL` 不是模型单方面决定。运行时会检查 `REQUIRED` 修改是否真的落盘、条件修改是否已有调查证据、证据是否覆盖目标、测试是否相关且发生在最新补丁之后。

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

### 6. Web 证据闭环

Web Research 支持查询范围守恒、搜索、抓取、来源血缘、时效候选比较、任务相关证据阈值和引用白名单。

搜索视角数、抓取数、独立域名、引用、时效与权威来源要求由模型写入 `TaskFrame.webEvidencePolicy`，Guardrail 只执行结构化策略，不再从原始问句正则推断“最新版任务”。

已处理的典型失败包括：

- 搜索传输失败后反复改写同义查询；
- 猜测可能存在的官方 URL；
- 搜索成功但抓取证据不足；
- 搜索排名被误当成时间排序；
- Guardrail 只拒绝、不告诉 Agent 下一步；
- 接近步数上限时继续调用工具而没有预留综合回答。

底层搜索服务的召回质量仍然会影响结果。Agent 可以改善查询、证据选择和诚实降级，但无法从未召回的页面中恢复事实。

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

- 声明式 `SKILL.md` 发现和受控上下文注入；
- 真正只读的 Plan 模式；
- MCP stdio / Streamable HTTP tools runtime；
- repository-local Markdown/TXT RAG；
- 本地/远程 Embedding 与缓存；
- AgentBench 脚本化和真实模型评测入口；
- Capability Registry 与产品能力事实校验；
- 环境诊断、日志和 Session 调试命令。

这些能力共享现有权限系统，不能绕过 Task Contract。

## 当前真实短板

### 模型与评测

- 真实模型任务成功率尚未形成足够大的公开 benchmark。
- 自动化测试主要证明运行时确定性，不代表所有模型都能稳定规划。
- TaskFrame 和动作选择仍依赖模型质量；中性 fallback 保证架构不倒退到硬编码路由，但不能替代可用模型。
- 缺少按模型、任务类别和重复次数长期维护的成功率/成本趋势。

### 语义与控制边界

- 多 Agent 要求进入 `TaskFrame.collaboration`，长会话取证进入 `TaskFrame.conversationEvidence`，Web 时效要求进入 `TaskFrame.webEvidencePolicy`。
- 系统使用中性的最近窗口解析 TaskFrame，再根据模型给出的语义查询从完整 Session 有界召回历史消息和相邻上下文；它不是向量检索。
- 产品元事实校验、危险命令、路径、URL 血缘和 Memory 召回仍有确定性规则，但这些规则不选择 Direct/Web/Edit 执行模式。
- 配置中的 MCP Tool 可被模型逐个发现和申请；授权精确到 `<server>__<tool>`，不会隐式获得整个 Server、仓库写入或命令能力。Plan/固定只读只开放安全只读 MCP，修改型外部调用仍需逐次显式批准。

### 安全与隔离

- 命令、工具和子 Agent worktree 是应用层隔离，不是强安全沙箱。
- 运行仓库自带的测试脚本仍需信任该仓库。
- MCP Server 属于外部进程或服务，其权限边界取决于配置和运行环境。

### Web 与外部系统

- 搜索质量受提供商影响。
- 没有专业体育、金融、新闻等垂直实时 API。
- 尚未实现逐条 claim-source 的完整自动对齐。
- MCP 聚焦 tools runtime，未覆盖协议的所有资源、Prompt、认证和服务端主动请求场景。

### 产品化

- CLI 是主要产品界面，没有 IDE 集成、Web 控制台或持续式全屏 TUI。
- 本地 JSONL 和文件锁适合单用户 CLI，不适合多租户服务。
- 配置 profile、版本发布、安装分发和跨平台现场验证仍可继续打磨。

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
