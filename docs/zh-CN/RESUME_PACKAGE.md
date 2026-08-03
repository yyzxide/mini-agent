# 简历与项目表达

这份材料用于把 `mini-coding-agent` 准确地表达成一个有工程深度的面试项目。目标不是包装成功能最多的 Agent，而是让面试官快速理解你解决了哪些真实问题、做了哪些设计取舍、如何验证结果。

## 推荐定位

稳妥版本：

> 独立实现一个本地 AI Coding Agent CLI，使用模型 TaskFrame、统一 AgentLoop 和任务契约管理语义理解、最小权限工具调用、上下文选择、仓库修改、验证、执行审计与隔离式多 Agent 协作。

不要使用：

> 完整复刻 Claude Code / Codex，达到生产级，可以自主完成任意复杂开发任务。

前者能够由代码、测试和演示证明；后者无法证明，也容易被追问击穿。

## 简历条目

### AI 应用 / Agent 工程方向

> **mini-coding-agent｜TypeScript / Node.js**
>
> 设计并实现本地 AI Coding Agent CLI，以 Schema 约束的模型 `TaskFrame` 和单一 `AgentLoop` 统一普通回答、Web 研究、仓库分析与代码修改；构建最小权限工具系统、上下文压缩、证据完成性门禁和 JSONL 审计链路。实现 Writer/Reviewer 子代理在临时 Git worktree 中隔离开发、验证和审查，由主 Agent 基于基线指纹安全合入冲突补丁。

### 后端 / 平台 / DevTools 方向

> **mini-coding-agent｜TypeScript / Node.js**
>
> 独立完成本地 Coding Agent 执行平台，包含结构化 Tool Registry、路径与命令安全、unified diff 校验、实时命令输出、Session/Checkpoint 恢复和版本化 Runtime Event；通过契约隔离读写、Web、命令与委派权限，并使用自动化测试覆盖异常恢复、并发改动冲突和完成性校验。

### 一行精简版

> 基于 TypeScript 实现契约驱动的本地 AI Coding Agent，覆盖受控工具执行、上下文治理、仓库 Patch、验证审计和隔离式多 Agent 协作。

## 最值得写的五个亮点

简历空间有限时，优先选择：

1. **单 AgentLoop + Task Contract**

   任务差异由能力、证据、输出和步数契约表达，不维护多套重复执行器。

2. **统一语义编译与权限安全**

   所有开放式请求都由模型编译为 Schema 校验的 TaskFrame；非法结果有界修复后仍失败则停止执行，本地契约与 Guardrail 阻止模型越过只读、权限和证据边界。

3. **隔离式多 Agent**

   Writer 在临时 worktree 修改并验证，Reviewer 读取物化补丁，父 Agent 独占合入并检查基线冲突。

4. **证据完成性**

   成功状态由仓库读取、文件覆盖、Patch、验证时序、Web 来源和引用等本地证据决定，而不是相信模型自述。

5. **可观察与可恢复**

   版本化事件流、终端时间线、Session、Checkpoint、任务级 Diff 和 Token/Cache/Context 遥测支持问题重现。

RAG、Memory、MCP、Skill 可以作为追问时的扩展能力，不建议在简历首段堆满。

## 面试开场

### 30 秒

> 我做了一个本地 AI Coding Agent CLI。它不是直接让模型读写文件，而是先把用户请求编译成带权限和完成条件的任务契约，再统一进入 AgentLoop。本地运行时负责工具、Patch、命令、证据校验和审计；复杂任务还可以让 Writer 和 Reviewer 在隔离 worktree 中协作，最后由主 Agent 安全合入。

### 1 分钟

> 项目的出发点是：聊天模型可以生成代码，但不能直接被信任去决定权限、执行副作用或宣布任务成功。我把回答、Web、Review、Repository Analysis 和 Change 统一到一个 AgentLoop，用 AI TaskFrame 表达语义，用 Task Contract 控制能力和完成条件。模型每轮只返回结构化 Decision，本地运行时执行工具、检查 Patch、运行命令并验证证据。多 Agent 场景下，Writer 在临时 worktree 开发和测试，Reviewer 审查修改后的真实文件，父 Agent 比较基线后再合入。所有过程进入终端时间线和本地 Session，方便回归和排障。

### 3 分钟结构

1. 问题：模型输出代码不等于可靠完成仓库任务。
2. 约束：权限、上下文、外部证据、副作用和失败恢复。
3. 方案：AI TaskFrame → Task Contract → AgentLoop。
4. 难点：语义契约、完整文件覆盖、验证时序、多 Agent worktree、冲突处理。
5. 结果：确定性测试、AgentBench、三组现场演示。
6. 边界：应用层沙箱、真实模型成功率和搜索提供商质量。

## 适合投递的岗位

高度匹配：

- AI 应用工程；
- Agent / Workflow / LLM 工程；
- DevTools / 工程效率；
- 平台工程；
- Node.js / TypeScript 后端。

也可作为加分项目：

- 测试开发与自动化平台；
- 全栈或客户端转平台；
- 中后台研发。

若投递高级 Agent 基础设施岗位，需额外证明生产部署、多租户、强沙箱、真实成功率和成本治理经验。

## 常见追问对应材料

| 追问 | 建议回答入口 |
| --- | --- |
| 为什么不是 API 壳子？ | Task Contract、本地 Guardrail、证据完成性 |
| 模型会不会乱改？ | 最小权限、Patch check、Writer worktree、父级合入 |
| 为什么需要多 Agent？ | 实现与审查的主体分离，不是为了角色数量 |
| 上下文怎么压缩？ | structured salience、双预算、来源追踪 |
| 为什么不显示思维链？ | 隐藏推理不可依赖；展示 Decision、证据和 Guardrail |
| Web 搜错怎么办？ | 范围守恒、来源血缘、证据不足降级 |
| 如何证明优化有效？ | 结构型回归、AgentLoop 场景、AgentBench |
| 与 Codex/Claude Code 差距？ | 产品规模、模型、沙箱、生态和真实指标 |

## 不可夸大的边界

不要声称：

- 生产级强安全；
- 完整覆盖 MCP 协议；
- 稳定实时搜索所有领域；
- 已经拥有大规模真实 Agent benchmark；
- 模型隐藏思维链可完整展示；
- 多 Agent 一定优于单 Agent；
- 可以替代成熟商业 Coding Agent。

准确说法：

- 应用层最小权限与副作用控制；
- MCP tools 与静态 resources/prompts runtime；
- 任务相关 Web 证据闭环；
- 确定性回归完整，真实模型评测仍需扩大；
- 可审计结构化决策，不展示私有推理；
- 只在分解带来价值或用户明确要求时使用子 Agent。

## 项目组合建议

如果求职目标包含后端或平台岗位，最好再准备一个传统业务系统项目：

- `mini-coding-agent` 展示 Agent、工具链、系统设计和工程探索；
- 业务项目展示数据库、缓存、并发、接口、部署和业务建模。

两个项目组合比继续给 Agent 添加更多边缘功能更有说服力。

## 最终表达原则

讲项目时始终按以下顺序：

> 问题 → 约束 → 设计 → 关键失败案例 → 验证 → 边界

不要按“我支持了多少条命令”讲。这个项目真正的竞争力，是把模型的不确定输出放进一个可控制、可验证、可恢复的本地执行系统。
