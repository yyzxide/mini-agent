# 面试问答

## Q1：这个项目解决什么问题？

它解决的是“让 AI 在本地仓库中可控地完成代码任务”。普通 ChatGPT 只能给建议，`mini-coding-agent` 能在仓库里搜索代码、读文件、应用 patch、执行命令、根据错误继续修复，并把全过程记录下来。

## Q2：为什么做成 CLI？

Coding Agent 最核心的场景发生在开发者本地仓库。CLI 最短、最直接，不需要后端服务和页面就能跑通核心闭环。先把 CLI 做扎实，比先做一个漂亮页面更有价值。

## Q3：为什么删掉后端和前端？

因为它们不是当前项目的核心。后端和前端会把叙事带向普通业务系统，而这个项目真正要展示的是 AgentLoop、工具系统、权限、安全边界、session 和真实模型调用。业务后台可以作为另一个独立项目做。

## Q4：AgentLoop 怎么工作？

每轮循环会构建上下文，调用 LLM，得到结构化 `AgentDecision`。如果是 `tool_call` 就执行工具，如果是 `apply_patch` 就检查并应用 patch，如果是 `run_command` 就执行命令，如果失败则把日志放回上下文继续修复，直到 `final` 或达到最大步数。

## Q5：模型会不会直接操作文件？

不会。模型只返回结构化决策。文件读取、搜索、patch 应用和命令执行都由本地 TypeScript 工程代码负责。

## Q6：工具系统怎么设计？

每个工具都有统一接口：`name`、`description`、`inputSchema`、`permissionLevel`、`execute`。`ToolRegistry` 负责注册、查找、输入校验、执行和错误包装。

## Q7：为什么用 zod？

LLM 输出不可信，必须校验工具参数。zod 可以把运行时校验和 TypeScript 类型联系起来，工具输入错误时能返回结构化错误，而不是让主流程崩掉。

## Q8：如何保证路径安全？

所有路径都会通过 `resolveRepoPath(repoPath, targetPath)` 解析成绝对路径，再判断结果是否仍在仓库目录内。这样 `../` 和绝对路径逃逸都会被拒绝。

## Q9：patch 为什么不用直接写文件？

patch 更适合审计和回滚。应用前可以预览，可以 `git apply --check`，失败时能得到明确错误，成功后可以直接用 `git diff` 展示最终变更。

## Q10：命令执行有什么保护？

命令有超时、输出截断和危险命令拦截。比如 `rm -rf /`、`sudo`、`mkfs`、`shutdown`、`reboot`、`chmod 777 /` 会被默认拦截。

## Q11：为什么 session 用 JSONL？

JSONL 适合本地 Agent：追加简单、人工可读、崩溃后已有记录不丢、无需数据库，也方便未来被其他系统消费。

## Q12：现在是真模型还是 mock？

产品运行路径是真实 OpenAI-compatible API。测试里仍然会 stub fetch 或用 scripted LLM，这是为了自动化测试稳定，不是产品功能。

## Q13：配置 API key 为什么放文件里？

本地开发时配置文件更直观。`mini-agent.config.json` 被 gitignore 忽略，`config show` 默认脱敏。也支持环境变量，适合 CI 或临时覆盖。

## Q14：这个项目难点在哪里？

难点不在调用一次 API，而在把模型输出变成可控执行：结构化决策、工具 schema、路径安全、patch check、命令安全、测试反馈、session 审计和错误恢复。

## Q15：如果测试失败，Agent 怎么继续？

`CommandRunner` 会返回结构化失败结果，包括 stdout、stderr、exitCode。AgentLoop 把这些信息放回上下文，模型下一轮可以继续搜索、读取文件或生成修复 patch。

## Q16：有什么不足？

当前不是生产级沙箱；上下文压缩还比较简单；复杂仓库的任务规划依赖模型能力；没有远程 PR 创建和多人控制面。

## Q17：后续怎么扩展？

优先方向是增强 Prompt、改进决策解析、加入 dry-run、增强 session replay、识别项目测试命令。如果未来需要平台化，可以单独做后端/前端，不把它们绑死在 CLI 仓库里。
