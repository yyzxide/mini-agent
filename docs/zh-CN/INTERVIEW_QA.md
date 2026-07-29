# 面试问答

以下回答基于当前实现。回答时应结合代码、测试或演示，不要把 Roadmap 描述成已经完成。

## Q1：这个项目解决什么问题？

聊天模型可以生成代码，但不能直接被信任去决定权限、执行副作用或宣布任务成功。项目把模型放进一个本地可控循环：自然语言先编译成任务契约，模型提出结构化动作，本地运行时执行工具、Patch 和命令，并用证据检查完成性。

## Q2：为什么不是普通 API 聊天壳？

关键逻辑不在 Prompt 里：

- TaskFrame 和 Task Contract；
- Tool Registry、Schema 和权限；
- 路径、Patch、命令和网络边界；
- Context 选择与压缩；
- Guardrail 与完成条件；
- Session、Checkpoint、事件和任务 Diff；
- Writer/Reviewer worktree 与父级合入。

换一个模型，以上本地控制仍然存在。

## Q3：为什么做成 CLI？

Coding Agent 需要直接面对仓库、Git、命令和终端。CLI 能复用开发者已有工具，减少额外服务边界，也让项目聚焦 Agent 执行内核。当前没有 Web 页面是产品范围选择，不是不能实现。

## Q4：一次请求怎么运行？

```text
User request + Conversation
  -> AI TaskFrame
  -> AgentTaskContract
  -> AgentLoop
  -> Context / LLM / Decision / Guardrail / Action
  -> evidence / events / checkpoint / final
```

Direct、Web、Review、Analysis 和 Change 都进入同一个 AgentLoop。它们只是不同 TaskFrame effects 和证据要求。

## Q5：为什么删除 TaskRouter？

因为自然语言任务不是有限枚举。先用关键词决定 Direct/Web/Edit 会让早期标签变成能力闸门，例如 Web 搜索后无法写代码，或文件分析没有 `read_file`。现在模型生成 TaskFrame，动作由同一 AgentLoop 自主选择，本地层只负责授权和安全。

## Q6：TaskFrame 为什么需要模型？

“不是只分析”“如果确认有问题才改”“按刚才方案处理”包含组合语义、否定和跨轮指代。把这些问句穷举进正则会持续产生边界冲突。系统每轮都让模型生成严格 JSON Schema 的 TaskFrame，再由本地安全层执行不可突破的约束。

## Q7：模型语义判断错误会不会获得写权限？

不会只凭 TaskFrame 的写入效果获得权限。模型必须实际选择 Patch，Capability Negotiator 授权后还要经过只读约束、Permission、路径沙箱和 Patch 校验。非法 TaskFrame 会先自修一次；仍无效则 AgentLoop 在任何动作前 fail closed，而不是猜测用户意图。

## Q8：模型会不会直接操作文件？

不会。模型输出 `TOOL_CALL`、`APPLY_PATCH`、`RUN_COMMAND`、`DELEGATE` 或 `FINAL` 等结构化 Decision。本地代码负责解析、权限检查、执行和记录。Patch 会先验证，命令默认禁用 Shell，路径限制在仓库范围。

## Q9：如何防止模型“没做完却说完成”？

`FINAL success=true` 要通过本地后置条件：

- 写入任务必须有本轮 Patch；
- 要求完整读取时必须覆盖到 EOF；
- 源码变更需要相关且足够强的最新验证；
- Web 回答需要本轮来源和引用；
- 必需子任务必须成功；
- 最近一次失败验证不能被旧的成功结果覆盖。

## Q10：大文件为什么不一次全部塞给模型？

“能读完整文件”不等于“一次传完整文件”。`read_file` 使用 Token 受控分页，运行时记录来源版本和已覆盖行区间。完整审查任务只有覆盖 1 到 EOF 才能完成。这样既不受固定 800 行限制，也不会让一个大文件挤掉所有上下文。

## Q11：上下文压缩怎么做？

Session Memory 使用 structured salience：固定约束、最近对话、执行证据等分层，在字符和 Token 双预算下选择。系统记录每个来源的选中、裁剪和排除原因。压缩是确定性选择，不让无证据的模型摘要替换原始事实。

## Q12：Prompt Cache 是 Agent 自己控制的吗？

不是。Prompt/KV Cache 通常由模型服务商管理，Agent 只能尽量保持稳定前缀并记录服务商返回的 cached-token 指标。项目自己控制的是 Session Context、Long-term Memory 和 Embedding Cache，这些不能混为一谈。

## Q13：为什么不显示模型完整思考过程？

隐藏思维链不是稳定、可靠或适合暴露的审计接口。项目显示可验证的信息：显式计划、结构化 Decision、行动理由、工具输入/结果、Guardrail、错误和验证证据。服务商返回 reasoning token 时记录用量，但不打印私有推理文本。

## Q14：多 Agent 是怎么触发的？

仓库任务默认具备受控委派能力。模型把明确要求、自动选择或禁用协作编译进 `TaskFrame.collaboration` 与 `constraints.noDelegation`，本地 `TaskCollaborationPolicy` 只消费这份结构化记录，不再扫描原始问句。用户说“用两个 subagent，一个实现一个 review”时，TaskFrame 会让实际委派成为完成条件；`--agents` 只覆盖并发数，不是脚本式功能开关。

## Q15：Writer 子 Agent 为什么需要 worktree？

只生成 Patch 无法在修改后的真实文件上测试，也无法让 Reviewer 可靠读取依赖结果。Writer worktree 提供：

- 父级当前工作状态的隔离基线；
- 真实文件修改；
- 允许列表中的验证；
- 失败后继续修复；
- 相对私有基线的最终 Diff；
- 结束后的统一清理。

## Q16：多个 Agent 冲突怎么办？

子任务记录父级基线指纹。主 Agent 合入前重新计算父工作区状态；若发生变化，会重新验证 Patch。仍可干净应用则继续，冲突则返回 `DELEGATED_PATCH_CONFLICT` 并要求基于新基线重新委派，不自动覆盖。

## Q17：子 Agent 是安全沙箱吗？

不是强沙箱。它使用临时 worktree、工具限制和命令允许列表隔离副作用，但测试脚本仍运行仓库代码。生产环境需要额外的容器、系统调用限制、网络策略和资源配额。

## Q18：Web 搜索如何减少幻觉？

- 第一条查询保持用户实体、范围和限定词；
- URL 必须来自本轮搜索/抓取；
- 搜索结果只作为候选，重要来源需要抓取；
- 时效最高级比较版本/日期候选并优先权威来源；
- Transport 失败后不反复同义重试或猜 URL；
- 证据不足时允许诚实结束。

Agent 能改善证据流程，不能弥补搜索服务完全没有召回的内容。

## Q19：为什么要 Session、Runtime Log 和 Change Log 三套记录？

- Session/Event：还原一次对话和 Agent 执行；
- Runtime Log：记录跨任务运行状态和错误；
- Change Log：面向仓库改动的紧凑审计；
- Checkpoint：恢复中断中的有界工作状态。

它们的消费者和生命周期不同，强行合并会让恢复、调试和审计互相污染。

## Q20：长期记忆和 RAG 有什么区别？

Long-term Memory 保存受策略约束的用户偏好、项目约定、架构决策和已验证结果，用于未来任务上下文。RAG 索引 Markdown/TXT 文档，按来源和行号返回知识证据。两者可以共享 Embedding 技术，但语料、写入策略、引用要求和用途不同。

## Q21：MCP 做到了什么？

当前实现 stdio 和 Streamable HTTP 的 MCP tools runtime，包括初始化、`tools/list`、`tools/call`、名称隔离、权限映射、统一 Tool Registry 和生命周期关闭。

没有声称完整覆盖 resources、prompts、OAuth、服务端主动请求和所有兼容场景。

## Q22：如何测试 Agent，而不是只测试函数？

三层：

1. 单元测试：解析器、策略、工具和存储；
2. AgentLoop 场景：多步 Decision、失败恢复、证据门禁、子任务和冲突；
3. AgentBench：版本化数据集、成功率、工具选择、步数、Token、缓存、时延和失败分类。

真实模型模式需要多次重复，不能用一次幸运结果证明稳定。

## Q23：项目当前最大的不足是什么？

- 真实模型 benchmark 规模有限；
- 搜索质量受底层提供商影响；
- 子 Agent 是应用层隔离；
- 本地文件存储不是多租户架构；
- 缺少 IDE 集成与商业产品级交互；
- MCP 和外部系统覆盖仍有限。

这些属于产品和生产化差距，不应通过增加特殊问句规则来掩盖。

## Q24：和 Claude Code / Codex 有什么差距？

成熟产品拥有更强模型、长期真实任务数据、IDE/终端生态、强隔离执行环境、账号与组织能力、跨平台质量和专门的基础设施团队。本项目的价值是完整实现并解释其中一组核心工程问题，而不是宣称能力等价。

## Q25：如果改成多用户服务，怎么设计？

需要增加：

- API Gateway、认证和租户隔离；
- 每任务容器/沙箱与临时工作区；
- 队列、调度、并发和资源配额；
- PostgreSQL 等事务存储；
- 对象存储与集中日志；
- Secret Manager；
- 可观测性、计费和成本预算；
- 分布式取消、幂等与恢复；
- 网络 Egress 和 MCP 连接策略。

当前 JSONL + 本地 Git 的设计是单用户 CLI 的主动取舍，不能直接平移到 100 个并发用户。

## Q26：这个项目最能证明什么能力？

它最能证明的不是 Prompt 技巧，而是：

- 能从真实失败抽象通用控制层；
- 能设计状态机、权限、证据和恢复；
- 能处理模型不确定性与本地确定性代码的边界；
- 能维护测试、文档和架构演进；
- 能清楚说明已完成能力与尚未解决的问题。
