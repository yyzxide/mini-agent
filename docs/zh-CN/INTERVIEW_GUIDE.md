# 面试讲解稿

这份讲解稿与当前代码保持一致。重点是解释设计问题和取舍，不是背功能列表。

## 一分钟介绍

> `mini-coding-agent` 是一个本地 AI Coding Agent CLI。用户请求先经过追问解析和 TaskUnderstanding，再编译成带权限、证据、输出与步数要求的 Task Contract，最后统一进入 AgentLoop。模型只返回结构化 Decision，本地 TypeScript 运行时负责 Context、工具、Patch、命令、Guardrail 和 Session 审计。复杂仓库任务可以让 Writer 和 Reviewer 在隔离 Git worktree 中协作，但只有主 Agent 能合入父工作区。

## 三分钟架构讲法

### 第一层：TaskUnderstanding

系统需要先回答：

- 用户要操作什么：回答、研究、审查、分析、修改、知识检索还是本地状态；
- 目标是什么：世界事实、仓库、产品、Session 或纯推导；
- 是否显式要求 Web、仓库或修改；
- 回答形态与深度是什么；
- 外部事实需要什么证据。

高置信度简单请求使用确定性解析。条件、复杂否定和间接动作可以使用模型语义补全，但结果必须通过 Schema、置信度和本地安全合并。

### 第二层：Task Contract

`TaskContractBuilder` 把语义记录编译成：

- Capability：读、写、命令、Web、Knowledge、MCP、Delegation；
- Evidence：仓库读取、完整文件覆盖、Web 搜索/抓取、引用；
- Output：自然语言、Web grounded answer、Review、Plan 或 Task Result；
- Step Budget 和额外完成指令。

这一步把“模型能做什么”和“产品这一轮允许什么”分开。

### 第三层：AgentLoop

每轮执行：

```text
build context
  -> call LLM
  -> parse AgentDecision
  -> guardrail
  -> tool / patch / command / delegate / final
  -> record evidence and events
  -> continue or finish
```

Direct Answer 也进入 AgentLoop，只是契约为单步、无工具。Review 和 Repository Analysis 共用只读调查契约。仓库修改才开放 Patch 和受控命令。

### 第四层：证据与完成性

模型的 `FINAL success=true` 只是提议。本地运行时还会检查：

- 要求的仓库读取是否发生；
- 完整审查是否覆盖到 EOF；
- 修改任务是否真的产生 Patch；
- 验证是否相关、强度是否足够；
- 验证是否发生在最新补丁之后；
- Web 是否满足抓取、来源和引用条件；
- 必需子任务是否成功。

### 第五层：上下文与恢复

ContextBuilder 从用户目标、仓库状态、Session Memory、工具结果、Diff、错误、Skill、RAG 和完成契约中选择输入，并在 Token 预算下记录选择与裁剪原因。

Conversation、Session Memory、Long-term Memory 和 Prompt Cache 分开管理。Checkpoint 只保存恢复执行所需的有界状态，不把原始 Patch 或命令输出无限复制进上下文。

### 第六层：多 Agent

Writer 在 disposable worktree 中修改和验证；Reviewer 读取包含 Writer Patch 的真实文件；主 Agent 检查父级基线并决定合入。依赖失败会取消后续任务，必需 Writer 失败后主 Agent不能偷偷代写。

## 最值得强调的设计点

### 模型不是权限源

模型可以建议工具和 Patch，但 Task Contract 与执行层决定是否允许。即使模型输出错误动作，运行时也会拒绝并记录 Guardrail。

### 语义层不是问句白名单

项目曾经在不同模块堆积关键词和特殊句式，导致修复一个问题又产生另一个误路由。现在统一为 TaskUnderstanding，并只对真正复杂的表达调用模型消歧。

### 完成不是生成一段总结

仓库 Agent 最危险的幻觉之一，是没有读完、没有写入或测试仍失败，却输出“完成”。项目把完成条件变成本地可检查证据。

### 子 Agent 隔离的目的不是炫技

多 Agent 的价值是把实现、审查和最终合入分离。worktree 让 Writer 可以真实迭代，又不直接影响用户工作区；基线指纹处理并发变化。

### 可观察不等于输出思维链

隐藏推理不可稳定获取，也不应成为审计接口。项目展示显式计划、结构化 Decision、工具证据、错误、协议恢复和 Guardrail，这是可复核的执行事实。

## 一个真实的 A → B 案例

可以选“Writer 子代理”讲：

### A

- 子代理只返回模型生成的补丁文本；
- 无法在修改后的文件上运行测试；
- Reviewer 看不到真实物化文件；
- 父工作区变化后没有可靠冲突判断。

### B

- 为每个 Writer 创建临时 worktree；
- 覆盖父级 staged、unstaged 和未跟踪基线；
- 在子级应用 Patch、运行允许列表验证并继续修复；
- Reviewer 物化依赖 Patch；
- 返回相对私有基线的 unified diff；
- 父级比较指纹并重新校验；
- 所有路径清理 worktree。

### 边界

- 这是应用层隔离，不是 OS 沙箱；
- 仓库测试脚本仍然可能执行仓库代码；
- Patch 冲突会拒绝，不会自动进行任意语义合并。

这种讲法能体现你不仅写了功能，还理解失败模式和边界。

## 为什么做成 CLI

- Coding Agent 天然需要仓库路径、Git、命令和终端输出；
- CLI 容易复用现有开发工具；
- 本地运行让文件与凭据边界更直观；
- 项目可以把精力集中在 Agent 执行内核，而不是前后端页面。

这不代表 Web/TUI 没价值，只是当前作品的产品边界。

## 如何说明测试

不要只报测试数量。更好的表达：

> 我把曾经真实出现的误路由、上下文污染、Web 死循环、提前 Final、Writer 失败、父子补丁冲突等问题转成结构型回归。单元测试验证解析器和策略，AgentLoop 场景测试验证完整状态机，AgentBench 用脚本数据集检查质量门槛与成本指标。

真实模型不放进默认 CI，因为外部 API 具有随机性、成本、速率和凭据问题；真实模式使用 opt-in、多次重复评测。

## 当前不足

主动承认：

- 真实模型成功率样本仍少；
- 搜索效果受提供商召回影响；
- 子 Agent 不是强安全沙箱；
- MCP 重点覆盖 tools runtime，不是完整协议；
- 本地文件存储适合单用户，不适合多租户服务；
- 没有 IDE 集成和商业产品级交互体验。

同时说明这些边界已经记录在 Roadmap，而不是用更多宣传语掩盖。

## 回答策略

面试官深入追问时，按以下顺序回答：

1. 当时出现了什么具体失败；
2. 为什么旧设计会产生它；
3. 新抽象放在哪一层；
4. 权限和失败路径如何控制；
5. 用什么测试或演示证明；
6. 仍然解决不了什么。

如果不能指出对应代码、测试或事件，不要把设想描述成已完成能力。
