# 面试讲解稿

这份文档的目标是帮你把 `mini-coding-agent` 讲成一个完整工程，而不是“我写了一个调用大模型的脚本”。

## 30 秒版本

我做了一个本地运行的 AI Coding Agent 原型，叫 `mini-coding-agent`。它可以在代码仓库里接收自然语言任务，通过受控工具搜索代码、读取文件、应用 patch、运行测试、生成 diff，并把所有对话、工具调用和命令执行记录到本地 JSONL session。后面我又补了 Java 后端、React 控制台、Docker 沙箱和 Git Workflow，让它从 CLI 原型扩展成一个可视化、可审计、可隔离的本地代码任务执行系统。

## 1 分钟版本

这个项目模拟的是 Codex CLI 或 Claude Code 这类工具的核心闭环。我把系统拆成三层：TypeScript Runner、Java Backend 和 React Frontend。

TypeScript Runner 负责 Agent 本体：AgentLoop、工具注册、权限控制、patch 应用、命令执行、session/event 记录，并通过 OpenAI-compatible API 接入真实模型。Java Backend 不重复实现 Agent，而是作为控制面启动 Runner、记录任务日志事件、提供 REST/SSE API，并支持 Docker 沙箱执行。React Frontend 提供任务创建、任务详情、实时事件、日志、diff、session 和 Git Workflow 操作。

安全上，我做了路径越权检查、zod 参数校验、patch check、危险命令拦截、命令超时、Docker 网络开关和只读 runner 挂载。现在它已经能跑通从自然语言任务到代码修改、测试验证、diff 展示和本地提交草稿的完整 MVP。

## 3 分钟版本

我做 `mini-coding-agent` 时，核心思路是不要把它做成一个“聊天界面”，而是做成一个真正有工程闭环的 Coding Agent。

第一层是 TypeScript Runner。它包含 CLI、AgentLoop、ToolRegistry、PermissionManager、PatchManager、CommandRunner、SessionStore 和 LLM 抽象。用户输入任务后，AgentLoop 会构建上下文，调用 LLM 获取结构化 decision，然后执行工具、应用 patch、运行命令，最后输出 summary 和 git diff。每一步都会写入 `.mini-agent` 下的 JSONL session 和 event。工具输入用 zod 校验，输出统一为结构化 ToolResult，异常不会直接打断主流程。

第二层是 Java Backend。我没有让后端重新实现 Agent，而是让它作为任务控制面。它接收 HTTP 请求，校验 repoPath 是否在 workspace-root 内，然后以本地模式或 Docker 模式启动 TypeScript Runner。Runner 会输出 `MINI_AGENT_EVENT` 结构化事件，后端解析后落库，并通过 REST 和 SSE 暴露给前端。后端还负责任务状态机、日志保存、任务取消、session 读取、Docker workspace 管理和 Git Workflow。

第三层是 React Frontend。它提供任务列表、创建任务、详情页、事件时间线、stdout/stderr 日志、最终 diff、session records/events 和 Git Workflow 面板。事件默认走 SSE，断开后回退轮询，这样演示时体验比较稳定。

我特别关注安全边界。Runner 侧所有文件路径都必须 resolve 后仍在 repoPath 内，read_file 会拒绝二进制文件，patch 应用前先 `git apply --check`，命令执行有超时和危险命令拦截。后端侧校验 repoPath 不能越过 workspace-root。Docker 模式会复制仓库到独立 workspace，容器默认允许访问模型端点，也可以配置为无网络；同时限制 CPU/内存，只把 workspace 挂成可写，把 runner 挂成只读。

这个项目目前还是 MVP，不追求模型智能达到生产级，但工程结构已经为真实模型、失败修复循环、远程 PR、多用户隔离和更强沙箱策略留好了扩展点。

## 可以强调的技术亮点

### 1. 工具调用不是裸执行

模型不能直接读写文件或运行命令。所有动作都必须变成结构化 `AgentDecision`，再由 `ToolRegistry`、`PermissionManager`、`PatchManager` 或 `CommandRunner` 执行。

### 2. 可审计性是第一等能力

session/event 不是普通日志，而是系统设计的一部分。CLI、本地 JSONL、Java 后端、React 前端都围绕这个事件流工作。

### 3. 沙箱不是事后补丁

Docker 模式不是简单 `docker run`，而是包含 workspace 复制、路径规范化、资源限制、网络开关、只读 runner mount、容器取消和 workspace 保留。

### 4. 后端和 Runner 解耦

后端只负责任务控制，不侵入 Agent 实现。这样 CLI 可以独立工作，后端也可以替换 Runner 或新增执行模式。

### 5. 真实模型协议和测试隔离

生产运行只走真实 OpenAI-compatible API。为了让 CI 稳定，测试里用 scripted LLM 和 fetch stub 模拟模型返回，验证的是 AgentLoop、工具执行、patch、命令、session/event 这些工程闭环，而不是在测试里消耗真实 API。

## 可以讲的难点

### 难点一：如何让 Agent 可控

如果让模型直接输出 shell 命令和文件内容，系统很难审计和保护。我的做法是把模型输出限制为 `AgentDecision`，每种 decision 都有明确执行器和权限等级。

### 难点二：如何把 CLI 任务可视化

Runner 本来只是在终端里输出。为了让后端和前端看到细粒度过程，我增加了 `--event-stream`，让 Runner 同时输出机器可解析的 `MINI_AGENT_EVENT`。后端解析后存入数据库，前端通过 SSE 展示。

### 难点三：如何隔离任务执行

本地模式会直接修改用户仓库，不适合所有场景。因此我实现了 Docker 模式：先复制仓库到任务 workspace，再在容器中执行。这样即使 Agent 修改文件，也修改的是副本。

### 难点四：如何处理 patch 和 diff

直接写文件虽然简单，但不利于审计。我选择用 unified diff 和 `git apply --check`，每次修改都先预览、校验，再应用，最后用 `git diff` 作为最终交付物。

## 面试官可能追问的方向

- 真实模型输出不稳定怎么办？
- 命令安全靠字符串拦截是否足够？
- Docker 沙箱是否能防住恶意代码？
- session 为什么用 JSONL 而不是数据库？
- 为什么后端不用 Node.js 全栈？
- 如果要支持多人使用，怎么改？
- 如果要接 GitHub PR，怎么设计？
- 如果测试失败，Agent 如何继续修复？

这些问题的建议回答见 [面试问答](INTERVIEW_QA.md)。

## 简历写法

可以把项目写成：

```text
mini-coding-agent：本地 AI Coding Agent 原型
- 设计并实现 TypeScript Agent Runner，支持工具调用、patch 应用、命令执行、权限控制、git diff 和 JSONL session 审计。
- 抽象 LLM Client，支持 OpenAI-compatible 真实模型接入，并用测试 stub 保证自动化验证稳定。
- 实现 Java Spring Boot 控制面，支持任务状态机、日志事件落库、SSE 实时推送、Docker 沙箱执行和 Git Workflow。
- 实现 React + Vite 可视化控制台，支持任务创建、事件时间线、日志、diff、session 查看和 PR 草稿生成。
- 增加路径越权防护、危险命令拦截、patch check、命令超时、Docker 网络开关和资源限制等安全边界。
```

## 项目边界要主动说明

建议主动说清楚：

- 当前模型智能主要验证架构闭环，真实复杂任务质量还需要 prompt、上下文压缩和修复策略继续增强。
- Docker 沙箱是隔离层，不是完整安全产品；生产级还需要 seccomp、权限降级、网络策略、审计和密钥治理。
- Git Workflow 当前生成本地分支、commit 和 PR 草稿，还没有直接调用 GitHub/GitLab 创建远程 PR。

主动讲边界会显得更成熟，因为你知道工程系统和 demo 原型之间的差距。
