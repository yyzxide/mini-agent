# 面试问答

## Q1：这个项目解决什么问题？

它解决的是“让 AI 在本地仓库中可控地完成代码任务”。普通 ChatGPT 只能给建议，`mini-coding-agent` 能在仓库里搜索代码、读文件、应用 patch、执行命令、根据错误继续修复，并把全过程记录下来。

## Q2：为什么做成 CLI？

Coding Agent 最核心的场景发生在开发者本地仓库。CLI 最短、最直接，不需要后端服务和页面就能跑通核心闭环。先把 CLI 做扎实，比先做一个漂亮页面更有价值。

## Q3：为什么删掉后端和前端？

因为它们不是当前项目的核心。后端和前端会把叙事带向普通业务系统，而这个项目真正要展示的是 AgentLoop、工具系统、权限、安全边界、session 和真实模型调用。业务后台可以作为另一个独立项目做。

## Q4：AgentLoop 怎么工作？

`mini-agent run` 会先经过 `TaskRouter`。如果是普通问答或用户明确说“只要代码片段、不改文件”，就直接回答，不进入修改仓库流程。如果是写代码、实现 demo、修复仓库、补测试这类会真正影响文件的任务，就进入 AgentLoop。AgentLoop 每轮会构建上下文，调用 LLM，得到结构化 `AgentDecision`。如果是 `tool_call` 就执行工具，如果是 `apply_patch` 就检查并应用 patch，如果是 `run_command` 就执行命令，如果失败则把日志放回上下文继续修复，直到 `final` 或达到最大步数。

## Q5：模型会不会直接操作文件？

不会。模型只返回结构化决策。文件读取、搜索、patch 应用和命令执行都由本地 TypeScript 工程代码负责。

另外，用户问“你写入了吗？”时也不会让模型凭上下文猜。CLI 会读取当前 session 里的 `FILE_CHANGE` 记录，判断上一轮请求之后是否真的发生文件变更；如果没有记录，就明确说明没有查到本次落盘。这是为了避免模型把“回答了代码”误说成“已经写入文件”。

## Q6：工具系统怎么设计？

每个工具都有统一接口：`name`、`description`、`inputSchema`、`permissionLevel`、`metadata`、`execute`。`ToolRegistry` 负责注册、查找、输入校验、执行和错误包装。

`metadata` 里会标注工具来源、分类和能力边界，例如是否只读、是否可能修改本地状态、是否幂等、是否访问外部世界。这些信息会进入 LLM tool spec，也可以通过 `mini-agent tool manifest` 查看。

这样做的原因是：Tool Calling 不是简单把函数暴露给模型，而是要让模型和本地执行层都理解工具风险。

## Q7：为什么用 zod？

LLM 输出不可信，必须校验工具参数。zod 可以把运行时校验和 TypeScript 类型联系起来，工具输入错误时能返回结构化错误，而不是让主流程崩掉。

## Q8：如何保证路径安全？

所有路径都会通过 `resolveRepoPath(repoPath, targetPath)` 解析成绝对路径，再判断结果是否仍在仓库目录内。这样 `../` 和绝对路径逃逸都会被拒绝。

## Q9：联网能力怎么控制？

联网不是让模型随便访问网络，而是通过 `web_search` 和 `fetch_url` 两个受控工具完成。`web_search` 返回公开网页标题、URL 和摘要；`fetch_url` 读取公网 HTTP(S) 文档。工具会限制超时、下载大小和输出长度，拒绝 localhost、`.local` 和明显的内网 IP，并且只返回文本类内容。实时比分、动态页面或反爬页面仍可能拿不到完整数据，Agent 必须说明无法核验，不能编造。

同时，我专门处理了“模型否认工具事实”的问题。如果用户问“你不能联网吗？”，CLI 会本地回答“有受控联网能力”，不把它交给模型乱猜。如果某次 `WEB_ANSWER` 已经执行了 `web_search` / `fetch_url`，但模型最后仍说自己不能联网或需要手动开联网按钮，CLI 会拦截这类回答并要求重写。

## Q10：patch 为什么不用直接写文件？

patch 更适合审计和回滚。应用前可以预览，可以 `git apply --check`，失败时能得到明确错误，成功后可以直接用 `git diff` 展示最终变更。

## Q10.1：如果用户只说“写个 2048 游戏”，Agent 怎么知道文件落在哪里？

当前版本不会完全交给模型瞎猜。`ContextBuilder` 会注入一段 `New file placement guidance`，由本地 `FilePlacementAdvisor` 根据仓库里的 `src/`、`public/`、`tests/`、Maven/Node/Go 构建文件和主要语言分布，给出若干建议目标路径。模型再基于这些建议生成 patch。

## Q11：命令执行有什么保护？

命令有超时、输出截断和危险命令拦截。比如 `rm -rf /`、`sudo`、`mkfs`、`shutdown`、`reboot`、`chmod 777 /` 会被默认拦截。

## Q12：为什么 session 用 JSONL？

JSONL 适合本地 Agent：追加简单、人工可读、崩溃后已有记录不丢、无需数据库，也方便未来被其他系统消费。

## Q13：为什么还要 runtime log 和 change log？

session/event 更偏 Agent 业务记录；runtime log 用来排查系统运行问题，比如工具失败、命令失败、配置错误；change log 用来复盘每次任务做了什么，包括任务文本、模式、成功失败、摘要、变更文件、diff stat 和测试结果。三者分开，排障和 review 都更清晰。

## Q14：上下文记忆怎么管理？

当前分两层。第一层是短期 transcript memory：每个交互会话复用同一个 session，`SessionMemory` 会读取最近的用户消息、助手消息、任务总结、工具结果、命令结果和错误，注入直接回答、联网回答和 AgentLoop。第二层是本地长期记忆：`LongTermMemoryStore` 会把 `TASK_SUMMARY` 和 `/compact` 生成的 `MEMORY_COMPACTION` 索引到 `.mini-agent/memory/index.jsonl`。检索时先由 `MemoryQueryBuilder` 识别意图、实体和关键词，再由 `MemoryRetriever` 召回候选，`MemoryReranker` 按模式、实体、同 session 和时间因素重排，最后 `MemoryEvidenceSelector` 选择少量证据交给 `ContextBuilder` 注入 prompt。

需要注意的是，这还是轻量本地 RAG，不是成熟生产级向量系统。后续可以替换成真实 embedding、向量数据库、rerank 和记忆过期策略。

## Q15：和 Codex CLI / Claude Code 的思路有什么相似点？

相似点是 CLI 优先、受控工具、session 恢复、slash command、上下文压缩和本地审计。区别是本项目是教学和作品级 MVP，核心在 TypeScript 实现的 AgentLoop、ToolRegistry、PermissionManager、PatchManager、CommandRunner 和 JSONL 记录体系，不追求直接复刻完整产品。

## Q15.1：项目有没有 MCP？

当前有 MCP 适配层，但还不是完整 MCP runtime。

已经做了：

- 本地工具可以导出 MCP 风格 tool descriptor。
- descriptor 包含 inputSchema、permissionLevel、source、category 和 annotations。
- 有 MCP server config schema，能校验 command/url/args/enabled。
- CLI 支持 `mini-agent mcp tools` 查看本地工具描述。

还没做：

- 真正启动第三方 MCP server。
- stdio/SSE client。
- tools/list 和 tools/call 的远端转发。
- 外部 MCP 工具的权限映射和隔离。

面试时不要说“完整接入 MCP”，更准确地说是“已设计 MCP 风格工具桥接和配置模型，后续可扩展到真实 MCP runtime”。

## Q16：现在是真模型还是 mock？

产品运行路径是真实 OpenAI-compatible API。测试里仍然会 stub fetch 或用 scripted LLM，这是为了自动化测试稳定，不是产品功能。

## Q17：配置 API key 为什么放文件里？

本地开发时配置文件更直观。`mini-agent.config.json` 被 gitignore 忽略，`config show` 默认脱敏。也支持环境变量，适合 CI 或临时覆盖。

## Q18：这个项目难点在哪里？

难点不在调用一次 API，而在把模型输出变成可控执行：结构化决策、工具 schema、路径安全、patch check、命令安全、测试反馈、session 审计和错误恢复。

## Q19：如果测试失败，Agent 怎么继续？

`CommandRunner` 会返回结构化失败结果，包括 stdout、stderr、exitCode。AgentLoop 把这些信息放回上下文，模型下一轮可以继续搜索、读取文件或生成修复 patch。

## Q20：有什么不足？

当前不是生产级沙箱；上下文压缩还比较简单；复杂仓库的任务规划依赖模型能力；没有远程 PR 创建和多人控制面。

## Q21：后续怎么扩展？

优先方向是增强 Prompt、改进决策解析、加入 dry-run、增强 session replay、识别项目测试命令。如果未来需要平台化，可以单独做后端/前端，不把它们绑死在 CLI 仓库里。

## Q22：我原来主要做客户端，这个项目能帮我跳出去吗？

可以，但前提是你要讲对。

这个项目最有价值的点，不是“我也会用大模型”，而是你借它展示了：

- 后端/平台工程思维
- 工具系统抽象能力
- 安全边界设计
- session 和日志审计能力
- 任务编排和错误恢复能力

如果你把它讲成“我做了个 AI 聊天工具”，帮助不会太大。  
如果你把它讲成“我做了一个受控执行的本地 Agent 工程系统”，价值就会高很多。

## Q23：这个项目最适合投什么岗位？

最适合：

- Java / Go / Node.js 后端开发
- 平台工程 / 工程效率
- AI 应用工程
- Agent / Workflow / LLM 工程

也可以作为加分项用于：

- 测试开发
- DevTools
- 中后台研发

## Q24：面试官如果说“这不就是调 API 吗”，怎么回？

可以直接说：

> 如果只是调一次 API，这个项目根本不需要这么多模块。真正麻烦的是把模型输出变成可控执行系统，所以我才拆了 TaskRouter、AgentLoop、ToolRegistry、PatchManager、CommandRunner、SessionStore 和日志审计。这个项目的难点不在请求模型，而在工程闭环。

这个回答通常很有效，因为它把讨论从“会不会用模型”拉回“会不会做系统”。
