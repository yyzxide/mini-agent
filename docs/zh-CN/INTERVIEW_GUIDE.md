# 面试讲解稿

## 1. 一分钟介绍

我做了一个本地运行的 AI Coding Agent CLI，叫 `mini-coding-agent`。它可以在任意 git 仓库中接收自然语言代码任务，通过受控工具搜索代码、读取文件、读取公网文档、应用 patch、执行测试命令、读取失败日志继续修复，最后输出修改总结和 git diff，并把所有对话、工具调用、命令执行和文件变更记录到本地 JSONL session。

我后来刻意把后端和前端删掉了，因为这个项目真正的价值是 Agent 本体：AgentLoop、工具系统、权限控制、patch 管理、命令执行、真实 LLM 接入和 session 审计。普通后台页面可以作为另一个业务项目做，不应该稀释这个项目的主线。

## 2. 架构讲法

这个项目可以拆成五层：

第一层是 CLI。它负责命令解析、交互式输入、一次性任务、配置管理、工具调试和 session 查看。

第二层是 AgentLoop。它维护当前任务状态，每轮构建上下文，调用真实 OpenAI-compatible API，拿到结构化 `AgentDecision`，然后执行对应动作。

第三层是工具和执行层。`ToolRegistry` 管理 `list_files`、`read_file`、`search_code`、`fetch_url`、`git_status`、`git_diff`、`apply_patch`。命令执行由 `CommandRunner` 负责，patch 由 `PatchManager` 负责。

第四层是安全边界。文件路径必须限制在 repoPath 内，patch 应用前必须 `git apply --check`，命令执行有超时和危险命令拦截，工具参数用 zod 校验。

第五层是本地记录。`.mini-agent/sessions` 保存会话状态，`.mini-agent/events` 保存事件时间线，便于恢复、排查和复盘。

## 3. 可以重点强调的亮点

### 3.1 模型只做决策，本地代码负责执行

模型不会直接读写文件或执行命令。它只能返回结构化 decision，例如 `tool_call`、`apply_patch`、`run_command` 或 `final`。真正的执行由本地 TypeScript 代码完成。

这让系统可控、可测，也方便加权限和审计。

### 3.2 工具系统是统一抽象

每个工具都有：

- `name`
- `description`
- `inputSchema`
- `permissionLevel`
- `execute`

`ToolRegistry` 负责校验参数、执行工具、包装异常和返回结构化结果。这样新增工具不需要改 AgentLoop 主逻辑。

### 3.3 路径安全不是口头说说

所有路径都会从 repoPath 解析，解析后再判断是否仍在仓库内。这样可以防止 `../` 和绝对路径逃逸。`read_file` 还会拒绝二进制文件，并限制读取行数。

### 3.4 Patch 落盘前先 check

模型生成 patch 后不会直接应用，而是先做安全检查，再执行 `git apply --check`。只有 check 通过才会真正 `git apply`。

这比让模型直接重写文件安全很多。

### 3.5 Session 是产品能力，不是普通日志

Agent 每一步都会写入 JSONL，包括用户消息、assistant 消息、工具调用、命令结果、patch 事件、测试结果和最终 diff。

这让本地 Agent 具备可追溯性，也为以后做 replay、可视化或外部集成留下接口。

## 4. 为什么删掉后端和前端

如果面试官问为什么删，可以这样回答：

我一开始扩展过后端和前端，但后来发现它们会把项目叙事带偏。这个项目的核心不是 CRUD 后台，也不是普通 Web 控制台，而是本地 AI Coding Agent 的执行闭环。

所以我把仓库收缩成纯 CLI：

- 运行更简单。
- 重点更清晰。
- 面试更容易讲深。
- 代码职责更聚焦。
- 后续如果要做业务后台，可以作为独立项目实现。

这个取舍本身也体现了工程判断：不是功能越多越好，而是主线越清楚越好。

## 5. 真实 API 接入

第一版可以用 mock 降低不确定性，但当前运行路径已经切到真实 OpenAI-compatible API。

配置方式有两种：

- `mini-agent.config.json`
- 环境变量

真实模型配置和 AgentLoop 解耦，未来换供应商时不需要重写工具系统和主循环。

## 6. 风险和不足

可以主动承认：

- 这不是生产级沙箱，执行命令仍然需要信任本地环境。
- Prompt 和 decision parser 还可以继续增强。
- 对大型仓库的上下文压缩还比较初级。
- 测试失败后的自动修复能力取决于模型质量。
- 目前没有远程 PR 创建和多用户控制面。

但当前 MVP 已经能证明最关键的工程闭环。

## 7. 简历写法

可以写成：

`mini-coding-agent`：基于 TypeScript/Node.js 实现本地 AI Coding Agent CLI，支持 OpenAI-compatible API、工具调用、代码搜索、文件读取、受控 URL 读取、patch 应用、命令执行、测试反馈、git diff 总结和 JSONL session 审计；实现 ToolRegistry、PermissionManager、PatchManager、CommandRunner、SessionStore 等模块，并通过 Vitest 覆盖工具、patch、命令、session、LLM 客户端和 AgentLoop 核心流程。

## 8. 如果你的背景原来偏客户端

如果面试官发现你之前主要做客户端，而这个项目明显更偏 CLI / 后端 / Agent 工程，他大概率会问一句：

> 为什么会做这个项目？

建议你这样回答：

我想主动把自己的能力边界从单端开发扩展到更完整的软件工程问题。这个项目正好要求我处理命令执行、文件系统、安全边界、任务编排、会话记忆、模型集成和测试回归，这些能力都比单纯做页面更接近通用工程岗位的要求。对我来说，它既是 AI 项目，也是一次很系统的工程化训练。

### 进一步的讲法

你可以补一句：

- 我不是为了“蹭 AI 热点”才做这个项目。
- 我是想借这个项目把系统设计、工具链、后端工程化和 AI 应用工程串起来。
- 所以我后来还刻意把不必要的前后端壳子删掉，收敛到核心 CLI Agent 主线。

这样会显得你是在主动做技术判断，而不是堆功能。
