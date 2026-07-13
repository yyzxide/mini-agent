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

### 结论分数：93 / 100

| 维度 | 分值 | 当前评分 | 说明 |
| --- | --- | --- | --- |
| CLI 可用性 | 15 | 15 | 除常规 run/review/session 外，现已具备 Skill 管理、长期记忆控制和 `/plan`→`/execute` 交互闭环。 |
| 工具系统 | 15 | 15 | 本地工具与 MCP stdio/Streamable HTTP 远端工具统一注册，具备工具发现、名称隔离、权限映射、调用转发、审计和生命周期关闭。 |
| Session、日志与记忆 | 15 | 15 | 长期记忆覆盖所有模式，支持真实 embedding provider、TTL、置信度、同主题替代、失败过滤、密钥脱敏和结构化压缩。 |
| Agent Loop 设计 | 15 | 13 | 除原有决策循环和质量闸门外，新增运行时硬约束的只读 Plan 模式；通用决策策略仍偏启发式。 |
| 问答与上下文体验 | 15 | 12 | 已支持 direct/web/review/agent 四模式，且代码生成默认落文件；但追问理解和事实可靠性仍有限。 |
| 代码结构 | 10 | 8 | 四种任务链、公共 Runtime、Tool 命令和 MCP 命令已拆出；`index.ts` 仍可继续拆交互命令与状态展示。 |
| 测试与可回归性 | 10 | 10 | 当前正常环境回归基线为 36 个测试文件、262 个测试用例，覆盖 MCP 双 transport、Web 证据闸门、Memory 治理、文档 RAG 和 Eval 指标。 |
| 产品化程度 | 5 | 4 | CLI、配置、日志、文档和演示材料比较完整；但仍缺少更强的评测体系、配置 profile、插件化、TUI/编辑器集成。 |

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

- `PatchManager` 执行 `git apply --check/apply` 时固定 `core.autocrlf=false`，避免不同机器的 Git 换行配置影响 patch 结果。
- `read_file` 和 `search_code` 会拒绝读取或搜索 `.git`、`.mini-agent` 等内部元数据路径。
- `search_code` 统一返回 POSIX 风格路径，并跳过异常的 ripgrep JSON 行，避免一个坏行拖垮整个搜索结果。
- `CommandRunner` 和 `AgentLoop` 相关测试去掉了 `printf`、`sh`、`false`、`sleep` 等 Unix-only 假设，Windows / Linux 下更稳定。
- 当前通过 `tsc --noEmit`、`tsc --noUnusedLocals --noUnusedParameters`；正常环境 Vitest 基线为 36 个测试文件、262 个测试用例。

## 为什么还不能算“优秀 Agent 产品”

和 `Claude Code` / `Codex` 相比，当前差距主要不在“有没有命令”，而在下面这些层面：

### 1. 决策能力还偏启发式

现在的很多模式切换仍依赖关键词、短追问补全、局部规则。

当前已补充热门榜单、`trending` 等时效意图，并支持把“切换吧 / 联网查吧”这类确认语直接切入 `WEB_ANSWER`，同时复用上一轮真实问题；但更开放的混合意图仍需要继续扩大评测集。

这让它已经可用，但还不够稳：

- 容易把模糊问题分错路由。
- 对跨轮追问的真实意图理解还不够强。
- 对“既要联网又要结合代码”的混合任务处理不够自然。

### 2. 上下文管理还不够精细

我们已经有：

- session transcript
- memory compaction
- `.mini-agent/memory/index.jsonl` 长期记忆索引
- 关键词 + 本地向量式混合检索
- query builder / retriever / reranker / evidence selector 分层
- readme / tree / diff / recent results 注入

但还没有做到更成熟的上下文治理，例如：

- 按任务阶段动态裁剪上下文
- 更细地区分长期记忆 / 短期记忆 / 工具证据的优先级
- 使用 SQLite/LanceDB/Qdrant 替换 JSONL 存储并提供 embedding 批量迁移
- 对语义相近但标题不同的长期记忆增加更强冲突检测

### 3. 联网能力还不够强

当前联网工具本质上还是：

- `web_search`
- `fetch_url`
- 来源排序
- 失败兜底

这已经比“裸搜一下”强很多了，但仍然没有：

- 专门的实时体育 / 金融 / 新闻 API
- 更稳定的官方源识别
- 多来源冲突校验
- 结果级引用和证据约束

### 4. CLI 入口已完成第一轮结构拆分

`src/cli/index.ts` 已从约 4270 行降到约 2250 行，Tool/MCP 命令也已拆出；入口仍主要承担：

- 命令注册
- 交互模式
- task route 决策衔接
- session summary / history / logs / changes 输出

四种执行链已经独立：

- `DirectAnswerTask.ts`
- `WebAnswerTask.ts`
- `CodeReviewTask.ts`
- `AgentLoopTask.ts` / `RepositoryAnalysisTask.ts`

公共的 Session 创建、事件初始化、用户消息记录、LLM 客户端创建和 Token 用量记录集中在 `CliTaskRuntime.ts`。Direct/Web/Review 的纯支持逻辑分别位于对应的 `*Support.ts`。拆分后构建、类型检查、未使用符号检查和全量回归全部通过。剩余结构优化主要是继续拆交互命令注册和状态展示，不再阻塞当前简历与演示使用。

## 目前最值得保留的亮点

如果写简历或面试讲项目，最值得讲的不是“我会调 API”，而是这些：

1. **多模式任务路由**
2. **结构化 ToolRegistry + zod 校验**
3. **本地 session/event/log/change-log 审计**
4. **补丁检查与命令执行保护**
5. **direct/web/review/agent 四条执行路径**
6. **短追问补全和 session 记忆复用**
7. **代码审查链路中的本地 grounding + verification**
8. **跨平台回归测试和工具安全边界**

## 当前明确短板

下面这些是现在最真实、最需要承认的短板：

1. `TaskRouter` 仍是规则驱动，泛化能力一般。
2. `WebQuestionPlanner` 和联网回答仍会受到数据源质量限制。
3. 长期记忆已有真实 embedding、TTL、置信度和同主题替代，但存储仍是 repo-local JSONL，不会自动跨机器同步。
4. Agent Harness 已有 suite 指标与失败分类，但真实任务 scenario 数量还不够多。
5. MCP 已支持 tools runtime，但尚未覆盖 resources/prompts、server-initiated request、OAuth 和旧 SSE 回退。
6. CLI 命令注册与交互状态展示仍集中在入口文件，后续扩展 TUI 或更多命令前需要继续拆分。

## 后续优化优先级

### P0：必须做

1. 把 `src/cli/index.ts` 中的交互命令注册和状态展示继续拆为独立模块
2. 给 task routing、follow-up rewrite、web answer 增加更多回归测试
3. 为联网回答增加 claim-source 对齐和多来源冲突检测
4. 为 direct/web/review/agent 四种模式增加统一的响应渲染层
5. 扩展 Agent Harness 的真实任务 scenario 数据集

### P1：强烈建议做

1. 评估 SQLite/LanceDB/Qdrant 等存储并实现 embedding 迁移
2. 引入更细的 session memory 分层和过期策略
3. 给现有“计划 -> 执行”闭环增加执行后复盘和计划偏差分析
4. 为 web answer 增加来源引用摘要
5. 扩展 MCP resources/prompts、server-initiated request 与认证

### P2：有余力再做

1. TUI 界面
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
