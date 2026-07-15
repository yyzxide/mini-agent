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

所有路径都会通过 `resolveRepoPath(repoPath, targetPath)` 解析成绝对路径，再判断结果是否仍在仓库目录内。这样 `../` 和绝对路径逃逸都会被拒绝。`read_file` 和 `search_code` 还会拒绝 `.git`、`.mini-agent` 这类内部元数据路径，避免把仓库配置、session、日志和记忆记录暴露给模型。

## Q9：联网能力怎么控制？

联网不是让模型随便访问网络，而是通过 `web_search` 和 `fetch_url` 两个受控工具完成。`web_search` 返回公开网页标题、URL 和摘要；`fetch_url` 读取公网 HTTP(S) 文档。工具会限制超时、下载大小和输出长度，拒绝 localhost、`.local` 和明显的内网 IP，并且只返回文本类内容。实时比分、动态页面或反爬页面仍可能拿不到完整数据，Agent 必须说明无法核验，不能编造。

同时，我专门处理了“模型否认工具事实”的问题。如果用户问“你不能联网吗？”，CLI 会本地回答“有受控联网能力”，不把它交给模型乱猜。如果某次 `WEB_ANSWER` 已经执行了 `web_search` / `fetch_url`，但模型最后仍说自己不能联网或需要手动开联网按钮，CLI 会拦截这类回答并要求重写。

## Q10：patch 为什么不用直接写文件？

patch 更适合审计和回滚。应用前可以预览，可以 `git apply --check`，失败时能得到明确错误，成功后可以直接用 `git diff` 展示最终变更。实现里还会固定 `core.autocrlf=false`，避免不同开发机的 Git 换行配置影响同一个 patch 的结果。

## Q10.1：如果用户只说“写个 2048 游戏”，Agent 怎么知道文件落在哪里？

当前版本不会完全交给模型瞎猜。`ContextBuilder` 会注入一段 `New file placement guidance`，由本地 `FilePlacementAdvisor` 根据仓库里的 `src/`、`public/`、`tests/`、Maven/Node/Go 构建文件和主要语言分布，给出若干建议目标路径。模型再基于这些建议生成 patch。

## Q11：命令执行有什么保护？

命令有超时、输出截断和危险命令拦截。比如 `rm -rf /`、`sudo`、`mkfs`、`shutdown`、`reboot`、`chmod 777 /` 会被默认拦截。

## Q12：为什么 session 用 JSONL？

JSONL 适合本地 Agent：追加简单、人工可读、崩溃后已有记录不丢、无需数据库，也方便未来被其他系统消费。

## Q13：为什么还要 runtime log 和 change log？

session/event 更偏 Agent 业务记录；runtime log 用来排查系统运行问题，比如工具失败、命令失败、配置错误；change log 用来复盘每次任务做了什么，包括任务文本、模式、成功失败、摘要、变更文件、diff stat 和测试结果。三者分开，排障和 review 都更清晰。

## Q14：上下文记忆怎么管理？

当前分两层。第一层是短期 transcript memory：每个交互会话复用同一个 session，但执行决策和聊天消息分开记录，重建对话时过滤工具调用等内部轨迹。遇到“这个难度如何”这种模糊指代，只把最近一次完整任务作为候选上下文，并暂停长期记忆和 Skill 注入；显式说“之前那个”时才保留历史范围。第二层是本地长期记忆：`LongTermMemoryStore` 会把 `TASK_SUMMARY` 和 `/compact` 生成的 `MEMORY_COMPACTION` 索引到 `.mini-agent/memory/index.jsonl`。检索时经过 query build、retrieve、rerank 和 evidence selection，最后只注入少量相关证据。

现在长期记忆还覆盖 Direct、Web、Review 和仓库分析，并支持显式 remember/forget。失败任务默认不索引，常见密钥会脱敏，召回内容使用不可信证据标签包裹，不能作为指令执行。Plan 模式则是另一条安全边界：它不依赖模型自觉，而是在工具暴露和 decision 执行两层阻止写操作。

需要注意的是，这仍是 repo-local 轻量 RAG，不是成熟生产级向量系统。现在默认使用离线哈希向量，也可切换 OpenAI-compatible embedding，并具备 TTL、置信度和同主题替代；后续主要是替换 JSONL 为向量数据库和做 embedding 迁移。

## Q15：和 Codex CLI / Claude Code 的思路有什么相似点？

相似点是 CLI 优先、受控工具、session 恢复、slash command、上下文压缩和本地审计。区别是本项目是教学和作品级 MVP，核心在 TypeScript 实现的 AgentLoop、ToolRegistry、PermissionManager、PatchManager、CommandRunner 和 JSONL 记录体系，不追求直接复刻完整产品。

## Q15.1：项目有没有 MCP？

当前已经实现 MCP tools runtime，但没有覆盖完整 MCP 协议。

已经做了：

- 支持 stdio 和 Streamable HTTP 的 initialize、tools/list、tools/call。
- 远端工具会做名称隔离、权限映射、统一审计和生命周期关闭。
- descriptor 包含 inputSchema、permissionLevel、source、category 和 annotations。
- 有 MCP server config schema，能校验 command/url/args/enabled。
- CLI 支持 `mini-agent mcp tools` 查看本地工具描述。

还没做：

- resources 和 prompts。
- server-initiated sampling / elicitation。
- OAuth 和更完整的认证 profile。
- 旧版 HTTP+SSE 回退、通知订阅和完整协议兼容测试。

面试时准确说“实现了 MCP tools runtime”，同时主动说明暂未覆盖 resources/prompts、server-initiated request、OAuth 和旧 SSE 回退。这样既能体现真实实现，也不会把协议支持范围吹大。

## Q16：现在是真模型还是 mock？

产品运行路径是真实 OpenAI-compatible API。测试里仍然会 stub fetch 或用 scripted LLM，这是为了自动化测试稳定，不是产品功能。

## Q17：配置 API key 为什么放文件里？

本地开发时配置文件更直观。`mini-agent.config.json` 被 gitignore 忽略，`config show` 默认脱敏。也支持环境变量，适合 CI 或临时覆盖。

## Q18：这个项目难点在哪里？

难点不在调用一次 API，而在把模型输出变成可控执行：结构化决策、工具 schema、路径安全、patch check、命令安全、测试反馈、session 审计和错误恢复。

## Q19：如果测试失败，Agent 怎么继续？

`CommandRunner` 会返回结构化失败结果，包括 stdout、stderr、exitCode。AgentLoop 把这些信息放回上下文，模型下一轮可以继续搜索、读取文件或生成修复 patch。

## Q20：有什么不足？

当前不是生产级沙箱；上下文压缩和大型仓库取证仍比较初级；长期记忆仍使用 repo-local JSONL；Eval 已有指标框架但真实任务数据集规模有限；MCP 只覆盖 tools runtime；复杂开放任务仍明显依赖模型本身的规划能力。

## Q21：后续怎么扩展？

下一步不应该继续盲目堆功能，而是扩大真实 Eval scenario、做 claim-source 对齐、增强上下文压缩和 embedding 索引迁移。如果未来需要平台化，再单独增加任务队列、状态存储、租户隔离、限流、取消和观测系统，不把多人服务能力硬塞进当前单机 CLI。

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

## Q25：Agent Harness 是什么？为什么普通单元测试不够？

Agent Harness 不是一种模型算法，而是 Agent 的运行和评测框架。它负责构造初始仓库、注入 scripted LLM、运行完整 AgentLoop、采集工具和步骤轨迹，再检查最终文件、diff、工具选择和任务状态。

普通单元测试适合验证一个 parser 或 tool；Harness 验证的是多个模块组合以后，Agent 能否完成一条用户任务。项目当前会统计 task success、平均步骤、LLM 调用、工具选择准确率和失败类别。scripted LLM 保证离线回归可重复，真实模型抽样则用于观察 Prompt 和模型本身的波动，两者不能互相替代。

## Q26：你怎么证明 Agent 优化后真的变好了？

不能只凭一次 demo。应该固定一组代表性 scenario，记录修改前后的成功率、工具选择、步骤数、LLM 调用、延迟、token 成本和 unsupported claim，再对失败做分类。还要区分确定性的离线回归和真实模型抽样：前者适合防代码回归，后者适合衡量模型和 Prompt 的实际表现。

当前项目已经有 Harness 和指标聚合，但场景数量仍有限，所以只能证明核心工程链路稳定，不能声称对所有开放任务都有高成功率。

## Q27：当前长期记忆和完整 RAG 有什么区别？

当前长期记忆已经包含 query building、关键词/向量召回、rerank、evidence selection、可选真实 embedding、TTL、confidence 和同主题 supersession，因此不是简单关键词搜索。

但它主要索引任务总结和压缩记忆，没有面向大规模文档的清洗与 chunking pipeline；存储还是 JSONL；切换 embedding 模型后缺少批量迁移；冲突检测也不是强语义级别。所以准确说法是“repo-local 轻量 RAG 和记忆治理”，不是生产级知识库。

## Q28：MCP 和 Function Calling 有什么区别？

Function Calling 解决“模型如何选择宿主提供的函数”；MCP 解决“宿主应用如何发现、连接和调用外部 Server 提供的标准化能力”。MCP Client 会把远端工具转换成模型可见的 tool spec，但 MCP 还涉及 transport、capability negotiation、server lifecycle 和协议消息，两者不是同一个层级。

## Q29：Agent 面临哪些特有安全风险？

除了传统的路径穿越、命令注入和 SSRF，还包括：

- 恶意用户直接要求绕过限制的 prompt injection。
- README、网页或工具结果中夹带指令的 indirect prompt injection。
- MCP Server 用误导性描述诱导模型调用的 tool poisoning。
- 恶意历史内容被长期召回的 memory poisoning。

防御不能只靠 Prompt，而要在本地执行层做最小权限、路径和网络约束、危险命令拦截、MCP 权限映射、记忆不可信标记和完整审计。当前项目是应用层防护，不等于生产级 OS sandbox。

## Q30：如果把单机 CLI 改成 100 个用户同时使用的服务，怎么设计？

需要把当前进程内和 repo-local 能力拆成服务化组件：

- API 层负责认证、限流、任务提交和流式事件。
- 任务队列负责削峰、重试、取消和优先级。
- Worker 在隔离工作区或容器中运行 Agent。
- 数据库存 session、任务状态、事件和租户配置。
- 对象存储保存较大的日志、patch 和产物。
- Redis 可用于短期状态、分布式锁和配额计数。
- 观测系统记录 trace、模型延迟、token、成本、工具成功率和失败分类。

还必须处理幂等性、仓库隔离、API Key 管理、并发写冲突和任务超时。当前 CLI 没有这些能力，因为它的定位是单用户本地 Agent，不能拿单机设计冒充多租户平台。
