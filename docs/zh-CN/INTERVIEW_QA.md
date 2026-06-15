# 面试问答

## Q1：这个项目和普通 ChatGPT 调 API 有什么区别？

普通聊天应用主要是输入 prompt、输出文本。这个项目的重点是让模型输出可执行但受控的动作：搜索代码、读取文件、应用 patch、运行命令、读取测试结果和生成 diff。每个动作都有 schema、权限、结构化结果和 session/event 记录，所以它更接近一个本地 Coding Agent 执行系统。

## Q2：为什么要先做 Mock LLM？

Mock LLM 可以把不确定性从系统闭环里拿掉。第一阶段我想验证的是工具系统、patch、命令执行、session、后端事件、前端展示是否通顺。如果一开始依赖真实模型，失败时很难判断是模型输出问题、prompt 问题，还是工程链路问题。Mock 跑通后，再接真实模型更稳。

## Q3：真实模型输出不稳定怎么办？

我把真实模型输出限制为结构化 `AgentDecision`，并用 parser 和 schema 做校验。解析失败时会返回结构化错误，而不是直接执行。后续还可以加强三点：第一，使用更严格的 JSON schema；第二，给模型提供少量工具调用示例；第三，加入自动修复格式的 retry。

## Q4：工具调用为什么要统一 ToolRegistry？

统一注册表可以集中处理输入校验、工具不存在、异常包装和权限元信息。如果每个工具在 AgentLoop 里手写分支，后续新增工具会让主循环越来越复杂，也很难做审计和测试。

## Q5：路径安全怎么做？

文件类工具会把 repoPath 和目标路径解析成绝对路径，然后确认结果仍在 repoPath 内。这样 `../` 和绝对路径逃逸都会被拒绝。后端也有一层 workspace-root 校验，确保 HTTP 请求不能访问配置边界外的目录。

## Q6：命令执行安全吗？

当前是 MVP 级安全：执行前有权限层、默认超时、输出截断和危险字符串拦截，例如 `sudo`、`rm -rf /`、`mkfs`、`shutdown`。这能挡住明显高风险命令，但生产级还需要更强的 shell 解析、命令 allowlist、容器隔离、权限降级和审计策略。

## Q7：为什么 patch 用 git apply，而不是直接改文件？

patch 更适合作为 Agent 的修改边界。它可以在应用前预览，可以用 `git apply --check` 校验，也可以自然生成最终 diff。直接写文件虽然简单，但不利于用户审核和后续 Git Workflow。

## Q8：Session 为什么用 JSONL？

JSONL 适合本地 Agent：可追加、易读、无需数据库、出错时也方便人工检查。每条记录一行，后端可以按行读取，前端也可以展示。等到多用户和集中化部署时，可以再把 session/event 投递到数据库或对象存储。

## Q9：Java 后端为什么不直接用 Node.js？

Runner 已经用 TypeScript 实现，后端我选择 Java 是为了展示控制面的工程能力：任务状态机、数据库、REST/SSE、Docker 编排、路径安全和 Git Workflow。这个拆分也让 Runner 和控制面职责更清晰。

## Q10：Docker 沙箱解决了什么问题？

Docker 模式把任务执行从原始仓库挪到复制出来的 workspace。Agent 修改的是副本，容器默认无网络，CPU/内存有限制，runner 只读挂载。这降低了本地演示和危险任务对原始仓库的影响。

## Q11：Docker 沙箱是不是绝对安全？

不是。Docker 是隔离层，但不是完整安全边界。生产级还需要非 root 用户、seccomp/AppArmor、只读根文件系统、capability drop、网络策略、secret 管理、镜像扫描和更强的审计。当前实现是 MVP 里最重要的第一层隔离。

## Q12：后端如何拿到 CLI 执行过程？

Runner 有 `--event-stream` 模式，会在 stdout 中输出带 `MINI_AGENT_EVENT` 前缀的 JSON 行。后端读取 stdout 时识别这些行，解析成事件并落库。普通 stdout/stderr 仍然作为日志保存。

## Q13：SSE 为什么还要轮询兜底？

本地开发时代理、浏览器或后端重启都可能导致 SSE 断开。前端用 SSE 获得实时体验，同时在断开后轮询 `/events`，保证演示时不会因为连接问题导致页面完全不更新。

## Q14：Git Workflow 做到什么程度？

当前支持在任务完成后创建分支、提交 diff、生成 PR title 和 Markdown description，并在前端展示状态。它不自动 push，也不直接创建远程 PR。这样能先把本地交付闭环跑通，再接 GitHub/GitLab API。

## Q15：如果测试失败，Agent 怎么继续修复？

架构上，命令结果会进入 AgentState 和上下文，下一轮 LLM 可以读取 stderr/stdout 后继续搜索、读文件、打补丁。当前 Mock 流程主要验证闭环，复杂真实修复能力还需要更强的真实模型 prompt、错误摘要、测试定位工具和最大修复次数策略。

## Q16：如何避免上下文越来越大？

当前 `ContextBuilder` 做的是基础拼接和最近结果裁剪，`read_file` 也限制读取行数。后续可以继续做 token budget、README/build 文件摘要缓存、最近失败日志优先、重要文件排序和历史消息压缩。

## Q17：为什么前端不直接调用 CLI？

浏览器不能也不应该直接访问本地文件系统和执行命令。前端只调用后端 API，后端负责路径校验、任务状态、日志事件、执行模式和安全策略。

## Q18：如何支持多人使用？

需要引入用户、项目、权限和任务隔离：

- 每个用户只能访问授权 workspace。
- 任务和 session 按用户隔离。
- API key 和模型配置进入安全配置中心。
- Docker workspace 按用户/任务隔离。
- 操作审计和配额限制进入后端。

## Q19：如果要接远程 PR，怎么扩展？

可以在 Git Workflow 后增加 Provider 层：

- `GitProvider` 接口：GitHub、GitLab、Gitea。
- 使用 token 创建 remote branch。
- push 本地 commit。
- 调用 API 创建 PR/MR。
- 把 PR URL 写回 `agent_git_workflow`。

同时要做 token 加密保存、权限校验和失败重试。

## Q20：这个项目最大价值是什么？

它把 Coding Agent 的关键工程问题串起来了：受控工具调用、权限、patch、命令反馈、session 审计、任务控制、实时事件、沙箱和交付流程。即使模型能力继续变化，这套执行和治理框架仍然有价值。
