# 项目现状评估

本文档用于回答三个很实际的问题：

1. 这个项目现在到底算不算合格。
2. 如果写进简历，强度够不够。
3. 和 `Claude Code` / `Codex` 这类成熟产品相比，我们差在哪里。

## 一句话结论

截至本轮修复，`mini-coding-agent` 已经是一个**可以写进简历、可以演示、可以继续打磨的合格偏上项目**。

但它还不是成熟产品级 Agent，更接近：

- **简历强度**：合格偏上
- **工程完成度**：MVP+
- **产品成熟度**：离 `Claude Code` / `Codex` 还有明显差距

## 100 分制评分

### 结论分数：94 / 100

| 维度 | 分值 | 当前评分 | 说明 |
| --- | --- | --- | --- |
| CLI 可用性 | 15 | 15 | 除常规 run/review/session 外，现已具备 Skill 管理、长期记忆控制和 `/plan`→`/execute` 交互闭环。 |
| 工具系统 | 15 | 15 | 本地工具与 MCP stdio/Streamable HTTP 远端工具统一注册，具备工具发现、名称隔离、权限映射、调用转发、审计和生命周期关闭。 |
| Session、日志与记忆 | 15 | 15 | 长期记忆覆盖所有模式，支持真实 embedding provider、TTL、置信度、同主题替代、失败过滤、密钥脱敏，以及可追溯的分层压缩。 |
| Agent Loop 设计 | 15 | 13 | 除原有决策循环和质量闸门外，新增运行时硬约束的只读 Plan 模式；通用决策策略仍偏启发式。 |
| 问答与上下文体验 | 15 | 12 | 已用统一 AgentLoop 覆盖 direct/web/review/analysis/repository task 契约；产品能力由 Registry 统一供给，并有组合式意图识别和输出事实校验，但开放域追问理解仍有限。 |
| 代码结构 | 10 | 9 | 任务执行已统一为 AgentLoop + TaskContract，终端与机器事件流共用版本化 Runtime Event；`index.ts` 仍可继续拆交互命令注册。 |
| 测试与可回归性 | 10 | 10 | 当前正常环境回归基线为 51 个测试文件、423 个测试用例，覆盖统一 TaskContract、产品能力纠偏、完整文件与超长单行读取、能力隔离、产物追问解析、任务级 Diff Viewer、终端遥测、存储并发恢复、MCP 双 transport、Web 证据闸门、Memory、RAG、embedding cache 和 Eval。 |
| 产品化程度 | 5 | 4 | CLI 已具备运行时间线、实时命令输出、Token/缓存/压缩遥测、任务级 Diff Viewer 和机器事件流；但仍缺少持续式全屏 TUI、配置 profile 和完整插件机制。 |

## 为什么说它已经“合格”

因为它已经不只是一个“调用一下大模型 API 的壳子”，而是具备了 Agent 项目的几个关键骨架：

- 有**任务路由**，不是所有输入都硬塞进代码编辑循环。
- 有**工具系统**，并且是结构化参数校验，不是随手拼命令。
- 有**真实 MCP tools runtime**，支持 stdio/Streamable HTTP 工具发现、权限映射、调用转发和生命周期关闭。
- 有**权限边界**，补丁和命令执行不是裸奔。
- 有**短期会话记忆和本地长期记忆检索**，不是每次都完全失忆。
- 有**独立文档 RAG**，支持增量分块索引、混合检索、元数据过滤、行号引用、证据不足拒答和离线评测。
- 有**本地审计记录**，出了问题能回放。
- 有**代码审查模式**，说明项目开始从“只会改代码”往“会分析代码”走。
- 有**联网资料模式**，说明它不是只能在 repo 里打转。
- 有**声明式 Skill 系统**，能按任务选择本地工作流，但不允许 Skill 绕过现有权限。
- 有**真正只读的 Plan 模式**，不只是输出一个 PLAN 进度消息，而是在工具暴露和运行时执行两层阻断写操作。

如果面试官看到这些点，并且你能把设计讲明白，这个项目是站得住的。

本轮修复后，项目可信度提升主要来自工程底座，而不是“又堆了几个功能”：

- 产品能力集中到 `CapabilityRegistry`，提示词、本地回答与运行时纠偏共享同一事实源；能力咨询按语义信号组合识别，显式联网动作仍会进入 Web 契约。
- `CapabilityTruthGuard` 会拦截模型对已注册联网/仓库写入能力的错误全局否认，写入可审计纠偏事件，同时不掩盖真实的单次权限或工具失败。
- 大文件读取不再以“调用过一次 `read_file`”冒充完整证据：运行时合并分页区间、校验内容哈希、在 Checkpoint 中保存紧凑覆盖状态，并阻止未覆盖到 EOF 的完整审查提前结束。
- Session Memory 压缩从字符比例与最近尾部升级为 `structured-salience-v2`：固定约束、最近对话和执行证据分层选择，同时受字符/Token 双预算控制，并保留来源与选择原因。
- `PatchManager` 执行 `git apply --check/apply` 时固定 `core.autocrlf=false`，避免不同机器的 Git 换行配置影响 patch 结果。
- `read_file` 和 `search_code` 会拒绝读取或搜索 `.git`、`.mini-agent` 等内部元数据路径。
- `search_code` 统一返回 POSIX 风格路径，并跳过异常的 ripgrep JSON 行，避免一个坏行拖垮整个搜索结果。
- `CommandRunner` 和 `AgentLoop` 相关测试去掉了 `printf`、`sh`、`false`、`sleep` 等 Unix-only 假设，Windows / Linux 下更稳定。
- 当前通过 `tsc --noEmit`、`tsc --noUnusedLocals --noUnusedParameters`；正常环境 Vitest 基线为 51 个测试文件、423 个测试用例。

## 为什么还不能算“优秀 Agent 产品”

和 `Claude Code` / `Codex` 相比，当前差距主要不在“有没有命令”，而在下面这些层面：

### 1. 决策能力还偏启发式

现在的很多模式切换仍依赖关键词、短追问补全、局部规则。

当前已补充热门榜单、`trending`、近期赛果和“谁赢了”等时效意图，并支持把“切换吧 / 联网查吧 / 你用搜一下啊”这类确认语直接切入 `WEB_ANSWER`，同时复用上一轮真实问题；但更开放的混合意图仍需要继续扩大评测集。

这让它已经可用，但还不够稳：

- 容易把模糊问题分错路由。
- 对跨轮追问的真实意图理解还不够强。
- 对“既要联网又要结合代码”的混合任务处理不够自然。

### 2. 上下文管理还不够精细

我们已经有：

- session transcript
- 字符/Token 双预算的 `structured-salience-v2` memory compaction
- `.mini-agent/memory/index.jsonl` 长期记忆索引
- 关键词 + 本地向量式混合检索
- query builder / retriever / reranker / evidence selector 分层
- 按任务阶段和优先级选择的 readme / tree / diff / recent results 注入
- 用户硬约束、最近对话、工具/命令证据的分层选择
- 来源 id、裁剪/丢弃统计和选择原因 trace

但还没有做到更成熟的上下文治理，例如：

- 使用供应商真实 tokenizer 代替启发式 Token 估算
- 建立 Turn / Task / Session 多级摘要和过期策略
- 对可选 LLM 语义摘要做来源约束、事实一致性检查和确定性回退
- 建立约束召回率、事实保留率和后续任务正确率的压缩 Eval
- 使用 SQLite/LanceDB/Qdrant 替换 JSONL 存储并提供 embedding 批量迁移
- 对语义相近但标题不同的长期记忆增加更强冲突检测

### 3. 联网能力还不够强

当前联网工具本质上还是：

- `web_search`
- `fetch_url`
- 来源排序
- 失败兜底
- 实时问题双独立来源门槛
- 回答引用 URL 白名单与一次自动重写

这已经比“裸搜一下”强很多了，但仍然没有：

- 专门的实时体育 / 金融 / 新闻 API
- 更稳定的官方源识别
- 多来源冲突校验
- 逐条 claim-source 对齐

### 4. CLI 执行链已统一为 TaskContract + AgentLoop

`src/cli/index.ts` 已从约 4270 行降到约 2450 行，Tool/MCP 命令、终端事件 Renderer 和 Diff Viewer 已拆出；入口仍主要承担：

- 命令注册
- 交互模式
- task route 决策衔接
- session summary / history / logs / changes 输出

旧的 `DirectAnswerTask.ts`、`WebAnswerTask.ts`、`CodeReviewTask.ts` 和 `RepositoryAnalysisTask.ts` 已删除。现在由 `TaskContractBuilder` 把路由提示编译成 `AgentTaskContract`，所有 CLI 任务只调用 `AgentLoopTask.ts`：

- Direct 使用单步、无工具契约。
- Web 使用仅开放公网工具并带来源门槛的迭代契约。
- Review 与 RepositoryAnalysis 共用只读 `REPOSITORY_INVESTIGATION` 契约。
- RepositoryTask 才开放补丁、命令、MCP 和委派。

Session 创建、事件初始化、LLM 客户端和 Token 用量仍由 `CliTaskRuntime.ts` 提供。新记录保留旧模式标签以兼容历史数据，同时增加统一执行引擎、任务类型和输出类型元数据。

## 目前最值得保留的亮点

如果写简历或面试讲项目，最值得讲的不是“我会调 API”，而是这些：

1. **单 AgentLoop + TaskContract 能力隔离**
2. **结构化 ToolRegistry + zod 校验**
3. **本地 session/event/log/change-log 审计**
4. **补丁检查与命令执行保护**
5. **Direct/Web/Review/Analysis 的统一执行生命周期**
6. **短追问补全和 session 记忆复用**
7. **按任务契约执行的本地证据和完成性门禁**
8. **跨平台回归测试和工具安全边界**

## 当前明确短板

下面这些是现在最真实、最需要承认的短板：

1. `TaskRouter` 仍是规则驱动，泛化能力一般。
2. `WEB_RESEARCH` 契约和公网工具仍会受到数据源质量限制。
3. 长期记忆已有真实 embedding、TTL、置信度和同主题替代，但存储仍是 repo-local JSONL，不会自动跨机器同步。
4. Agent Harness 已有 suite 指标与失败分类，但真实任务 scenario 数量还不够多。
5. MCP 已支持 tools runtime，但尚未覆盖 resources/prompts、server-initiated request、OAuth 和旧 SSE 回退。
6. CLI 命令注册与部分交互状态仍集中在入口文件，后续扩展更多 TUI 面板前需要继续拆分交互控制层。

## 后续优化优先级

### P0：必须做

1. 把 `src/cli/index.ts` 中的交互命令注册和状态展示继续拆为独立模块
2. 给 task routing、follow-up rewrite、web answer 增加更多回归测试
3. 为联网回答增加 claim-source 对齐和多来源冲突检测
4. 为不同 output contract 增加更丰富的结构化结果组件
5. 扩展 Agent Harness 的真实任务 scenario 数据集

### P1：强烈建议做

1. 评估 SQLite/LanceDB/Qdrant 等存储并实现 embedding 迁移
2. 在现有分层 compaction 之上增加 Turn / Task / Session 多级摘要、过期策略和压缩 Eval
3. 给现有“计划 -> 执行”闭环增加执行后复盘和计划偏差分析
4. 为 web answer 增加来源引用摘要
5. 扩展 MCP resources/prompts、server-initiated request 与认证

### P2：有余力再做

1. 基于 `AgentRuntimeEvent` 的持续式全屏 TUI 任务面板
2. 编辑器集成
3. 更细的工具权限配置
4. 并行工具调用调度
5. 更完整的插件机制

## 简历建议

现在这个项目已经可以放进简历，但更适合这样定位：

> 本地 AI Coding Agent CLI，聚焦仓库任务路由、工具调用、上下文记忆、代码审查、补丁应用与执行审计。

而不建议包装成：

> 对标 Claude Code / Codex 的完整工业级智能编程平台。

前者可信，后者容易被问穿。

## 一句话判断

如果目标是：

- **写简历**
- **做演示**
- **讲工程能力**
- **体现 AI Agent 理解**

那它已经够用了。

如果目标是：

- **真正替代 Claude Code / Codex**
- **高稳定度地处理复杂开放任务**
- **强联网事实问答**

那现在还远远没到头。
