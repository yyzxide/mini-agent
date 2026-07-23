# AI Agent 面试学习指南

这份文档不负责继续堆项目功能，而是回答两个问题：

1. 为了真正理解 `mini-coding-agent`，需要学习哪些知识？
2. 面试官沿着项目追问时，怎样才算不是只会背文档？

项目当前已经够用于简历和演示。接下来的主要风险不是“功能不够”，而是代码大量由 AI 辅助完成后，候选人无法解释模块为什么存在、方案有什么取舍、失败时如何定位。学习目标因此不是成为大模型算法研究员，而是具备 **AI 应用工程 + Agent 工程 + 后端工程** 的完整解释能力。

## 1. 学习优先级

| 优先级 | 主题 | 学习目标 |
| --- | --- | --- |
| P0 | LLM 基础与调用链 | 能解释模型输入输出、上下文、幻觉、延迟和成本 |
| P0 | Structured Output 与 Tool Calling | 能解释模型决策与本地执行的边界 |
| P0 | Agent Loop 与工作流编排 | 能画出循环、失败恢复和终止条件 |
| P0 | Context Engineering 与记忆 | 能解释短期记忆、长期记忆、压缩和优先级 |
| P0 | RAG | 能讲完整检索链，而不是只会说向量数据库 |
| P0 | Agent Evaluation / Harness | 能回答“怎么证明优化有效” |
| P0 | MCP | 能讲协议角色、transport、工具发现和安全边界 |
| P1 | Agent 安全 | 能识别 prompt/tool/memory 注入和执行风险 |
| P1 | AI 应用后端工程 | 能讲超时、重试、限流、观测、成本和异步任务 |

面试准备顺序建议严格按照表格推进。不要先研究复杂微调或 Transformer 推导，却讲不清自己的 `AgentLoop` 为什么需要最大步数。

## 2. LLM 基础与调用链

### 必须理解

- token、tokenizer、context window。
- system、user、assistant、tool message 的职责。
- temperature 和 top_p 对随机性的影响。
- max output tokens 和上下文预算的区别。
- 幻觉、过度自信和 unsupported claim。
- 长上下文为什么可能出现信息稀释、注意力偏移和成本上升。
- 流式输出与普通请求的区别。
- 模型能力、延迟、价格之间的取舍。

### 项目对应

- `OpenAICompatibleClient`
- `ContextBuilder`
- `MessageCompressor`
- `CliTaskRuntime` 中的 token usage 记录

### 典型追问

> 为什么不把整个仓库一次性塞给模型？

回答应包含：上下文窗口有限、无关内容会稀释有效证据、输入成本增加、大仓库无法一次装入，因此需要工具按需取证、预算裁剪和会话压缩。

### 学会标准

能不看文档解释一次 LLM 请求由哪些消息组成，能指出上下文过长时项目会在哪里裁剪，能说明为什么模型回答流畅不代表事实可靠。

## 3. Structured Output 与 Tool Calling

### 必须理解

- Function Calling / Tool Calling 的基本过程。
- JSON Schema 如何向模型描述工具输入。
- Structured Output 与“Prompt 里要求输出 JSON”的区别。
- 为什么模型输出必须做运行时校验。
- parse、repair、retry、fallback 的区别。
- 参数合法、权限允许、执行成功是三个不同层级。
- Tool Calling 是模型选择能力；真正执行仍由宿主程序完成。

### 项目对应

- `AgentDecision`
- `DecisionParser`
- `Tool`
- `ToolRegistry`
- Zod input schema
- `CodeReview` 的结构化 findings 与二次复核

### 典型追问

> 已经要求模型输出 JSON，为什么还需要 Zod？

模型输出属于不可信外部输入。JSON 语法正确不代表字段完整、类型正确或满足业务约束；Zod 用于运行时校验并把失败包装成结构化错误，避免错误参数直接进入文件、命令或网络执行层。

### 学会标准

能从模型生成 `TOOL_CALL` 开始，完整讲到 schema 校验、权限检查、工具执行、结果记录和下一轮上下文回灌。

## 4. Agent Loop 与工作流编排

### 必须理解

- Chatbot、Workflow、Agent 的区别。
- ReAct 的 thought/action/observation 思想；面试中不需要暴露模型隐藏推理，只需理解执行循环。
- Planner / Executor / Verifier。
- Plan-and-Execute 与边执行边规划的区别。
- 最大步数、连续失败限制和重复决策检测。
- 工具失败、patch 失败、命令失败如何进入下一轮。
- deterministic workflow 通常比开放式 Agent 更稳定。
- 什么时候应该使用规则路由，什么时候交给模型判断。

### 项目对应

- `TaskRouter`
- `AgentLoop`
- `AgentState`
- `TaskGuardrails`
- `AgentOperatingMode`
- `Plan` 模式

### 项目循环

```text
用户任务
-> 路由执行模式
-> 构建上下文
-> LLM 返回结构化 decision
-> 本地校验和执行
-> 记录 observation / error / diff
-> 回到下一轮
-> FINAL 或触发终止条件
```

### 典型追问

> 为什么 Agent 不能一直执行到成功？

因为模型可能重复同一个错误、不断消耗 token、持续修改错误方向，甚至放大危险操作。最大步数、重复决策检测和连续失败限制是成本、稳定性和安全性的硬边界。

### 学会标准

可以在白板上画出 AgentLoop，并解释每个终止条件、质量闸门和失败恢复路径。

## 5. Context Engineering 与记忆

Context Engineering 比“写一个好 Prompt”更宽，它关心每一轮到底给模型什么信息、按什么优先级、给多少。

### 必须理解

- 当前任务上下文、短期会话记忆、长期记忆、工具证据的区别。
- transcript memory 与 summary memory。
- 上下文裁剪、压缩和预算分配。
- recency、relevance、authority 三类优先级。
- 为什么历史记忆必须标记为不可信数据。
- memory poisoning 和间接 prompt injection。
- TTL、置信度、冲突、supersession。
- session 隔离和跨 session 召回。

### 项目对应

- `SessionMemory`
- `MessageCompressor`
- `ContextBuilder`
- `MemoryContextService`
- `LongTermMemoryStore`
- `<memory_evidence>` 不可信证据边界

### 当前实现

- 短期记忆：读取当前 session 最近的用户、助手、工具、命令、错误和摘要记录。
- 长期记忆：索引成功的任务总结、压缩记忆和显式记忆。
- 治理：密钥脱敏、失败任务排除、confidence、TTL、同主题 supersession。
- 安全：召回记忆只能作为历史证据，不能覆盖当前用户要求或触发工具执行。

### 典型追问

> 为什么不能把所有历史对话都重新塞进去？

应从上下文容量、成本、相关性、旧结论冲突和恶意历史内容五个方面回答。

### 学会标准

能说明短期和长期记忆分别解决什么问题，能解释一条旧记忆从写入、索引、检索到注入 Prompt 的完整生命周期。

## 6. RAG 与检索增强

RAG 不是“接一个向量数据库”。完整链路是：

```text
数据采集
-> 清洗与 chunking
-> embedding
-> indexing
-> query 构造或改写
-> candidate recall
-> metadata filter
-> rerank
-> evidence selection
-> Prompt 注入
-> grounded answer
-> evaluation
```

### 必须理解

- embedding 表示什么，为什么语义相近的文本向量更接近。
- cosine similarity 的直观含义。
- chunk size、overlap 和边界切分的影响。
- 关键词检索、稀疏检索、向量检索和混合检索。
- Top-K、precision、recall。
- rerank 与第一阶段召回的职责区别。
- metadata filtering。
- evidence selection 与 source diversity。
- RAG 为什么不能自动消灭幻觉。
- 证据不足时为什么应该拒答或降低确定性。

### 项目对应

- `RagDocumentLoader`
- `TextChunker`
- `RagStore`
- `KnowledgeSearchTool`
- `RagEvaluator`
- `MemoryQueryBuilder`
- `MemoryRetriever`
- `MemoryReranker`
- `MemoryEvidenceSelector`
- `EmbeddingProvider`
- `TaskContractBuilder` 与 `TaskGuardrails` 的 Web evidence assessment

### 当前已经实现

- Markdown/TXT 文档安全导入、按行 chunking、overlap 和来源 hash。
- 独立于长期记忆的 `.mini-agent/rag/index.jsonl` 文档索引。
- 按来源增量替换、来源/标签过滤、Top-K、来源多样性和上下文预算。
- 关键词与向量混合检索、文件行号 citation 和证据不足拒答。
- answerability accuracy、hit rate、Recall@K、MRR 离线评测。
- 中英文关键词和本地离线 embedding。
- 可选 OpenAI-compatible embedding provider。
- query building、候选召回、rerank、evidence selection。
- TTL、confidence 和同主题记忆替代。
- Web 回答在没有可读正文时拒绝给出确定性实时结论。

### 当前仍不是生产级 RAG 的原因

- JSONL 存储不适合大规模并发和高数据量。
- 切换 embedding 模型后能检测 provider 不匹配并要求重建，但仍缺少批量迁移工具。
- 没有 cross-encoder reranker、查询改写、PDF/OCR 和结构化表格解析。
- JSONL 单机索引没有多进程写锁、文档 ACL 和多租户隔离。
- 同主题冲突主要基于标题，不是强语义冲突检测。
- Web 回答还没有做到逐 claim 与 source 的自动对齐。

### 学会标准

能画出完整 RAG 链路，能解释 recall 与 rerank 的区别，并能诚实指出当前项目和生产级知识库之间的差距。

## 7. Agent Evaluation 与 Agent Harness

### Harness 是什么

Agent Harness 不是一种 Agent 算法，而是承载 Agent 运行、构造场景、注入依赖、采集轨迹和计算指标的测试框架。它解决的是：

> 修改 Prompt、路由或工具描述以后，如何证明 Agent 真的变好了，而不是只在一次人工演示中碰巧成功？

### 必须理解

- unit test、integration test、end-to-end test。
- regression set 与 golden case。
- offline eval 与 online eval。
- deterministic scripted model 与 real-model sampling。
- pass@1、task success rate。
- tool selection accuracy、tool execution success rate。
- 平均步骤、平均 LLM 调用、token cost、latency。
- unsupported claim rate。
- failure taxonomy：模型、工具、权限、循环保护、步数上限、期望不匹配。
- 数据集污染、过拟合固定 case 和 flaky eval。

### 项目对应

- `ScriptedLlmClient`：返回预设 decision，保证离线回归可重复。
- `AgentHarness`：创建临时 git 仓库、运行 AgentLoop、检查 diff 和文件。
- `runSuite`：汇总成功率、平均步骤、工具选择准确率和失败分类。
- Vitest：固定路由、Web、Review、Patch、Command、Memory 和 MCP 回归。

### 如何设计一条 scenario

一条有效 scenario 至少包含：

1. 用户目标。
2. 初始仓库和文件。
3. 模型决策序列或真实模型配置。
4. 预期成功状态。
5. 必须调用或禁止调用的工具。
6. 预期文件、diff 或回答约束。
7. 步骤数和 LLM 调用预算。

### 典型追问

> 你说优化以后效果更好，怎么证明？

不能只回答“我手动试过”。应该说明固定场景集、确定性离线回归、真实模型抽样、核心指标和失败归因，并承认当前场景规模仍有限。

### 学会标准

能独立设计五类 scenario：正确选工具、错误后恢复、禁止危险操作、证据不足拒答、达到循环保护后失败。

## 8. MCP

### 必须理解

- MCP 解决 Host 与外部能力提供方之间的标准化连接问题。
- Host、Client、Server 三个角色。
- MCP 基于 JSON-RPC 消息。
- initialize 与 capability negotiation。
- `tools/list`、`tools/call`。
- tool、resource、prompt 的区别。
- stdio 与 Streamable HTTP transport。
- server lifecycle、超时和断连处理。
- MCP 与模型 Function Calling 所处层级不同。

### 项目对应

- `McpClient`
- `StdioMcpClient`
- `HttpMcpClient`
- `McpRegistryLoader`
- `McpRemoteTool`
- `McpCommands`

### 当前实现边界

已经支持 stdio 和 Streamable HTTP 下的 initialize、工具发现和工具调用；远端工具按 `<server>__<tool>` 注册到统一 ToolRegistry，并映射到现有权限和审计体系。

尚未覆盖 resources、prompts、server-initiated sampling/elicitation、OAuth、旧版 SSE 回退和完整协议兼容测试。因此准确口径是：

> 实现了 MCP tools runtime，不是完整覆盖 MCP 全协议。

### 典型追问

> MCP 和 Function Calling 有什么区别？

Function Calling 描述模型如何选择一个宿主提供的函数；MCP 描述宿主应用如何发现和连接外部 Server 提供的标准化能力。MCP 工具最终仍可转换为模型可见的 tool spec，但两者不是同一个层级。

### 学会标准

能画出 Host -> Client -> Server，能讲一遍 stdio MCP Server 从启动、initialize、tools/list、tools/call 到 close 的生命周期。

## 9. Agent 安全

### 必须理解

- direct prompt injection。
- indirect prompt injection。
- tool poisoning。
- memory poisoning。
- path traversal、command injection、SSRF。
- least privilege。
- human-in-the-loop。
- audit trail。
- sandbox 与普通权限检查的区别。

### 项目对应

- `PermissionManager`
- `resolveRepoPath`
- `.git` / `.mini-agent` 内部路径保护
- `PatchManager` 的 check-before-apply
- `CommandRunner` 的危险命令拦截
- `FetchUrlTool` 的私网和重定向限制
- Plan 模式的工具暴露与运行时双重限制
- MCP 远端工具权限映射

### 典型追问

> Prompt 里写了“不要执行危险命令”，为什么还要本地拦截？

Prompt 是软约束，可能被模型忽略或被注入内容覆盖。权限、路径、网络和命令限制必须在确定性的本地执行层实现。

### 学会标准

能针对“恶意 README 诱导 Agent 上传密钥”给出威胁链路和至少三层防御，而不是只说加强 Prompt。

## 10. AI 应用后端工程

想投 AI 应用开发或后端岗位，不能只学 Agent 名词。还要能把模型服务当成一个高延迟、昂贵、可能失败的外部依赖来治理。

### 必须理解

- HTTP、SSE、WebSocket 的适用场景。
- timeout、retry、exponential backoff、circuit breaker。
- 幂等性、并发控制和任务取消。
- 限流、配额和租户隔离。
- Redis 缓存、消息队列和异步任务。
- 日志、指标、trace 和 request id。
- token、延迟、成功率和成本监控。
- 多模型路由、fallback 和降级。
- API Key、配置和日志脱敏。

### 和项目的关系

当前项目是单机 CLI，不需要强行加入 Redis、MQ 或微服务。但面试中要能说明：如果改造成多人服务，session 存储、任务队列、并发执行、权限隔离、模型限流和观测体系会如何变化。

### 学会标准

能回答“如果同时有 100 个用户提交 Agent 任务，怎么改造”，并覆盖任务队列、状态存储、取消、限流、隔离、日志和成本控制。

## 11. 四周学习安排

### 第 1 周：项目主链路

- LLM 消息、token、context window。
- Structured Output、Tool Calling、Zod。
- TaskRouter、AgentLoop、ToolRegistry。
- 每天脱离文档画一次执行链路。

验收：能做 5 分钟项目架构讲解，并回答一次工具调用如何执行。

### 第 2 周：Context、Memory、RAG

- session memory 与 context compression。
- embedding、cosine similarity、chunking。
- recall、rerank、evidence selection。
- 对照 Memory 模块走读一条记忆生命周期。

验收：能画 RAG 链路，能解释当前实现与生产级 RAG 的差距。

### 第 3 周：Eval、MCP、安全

- 设计 Agent scenario 和指标。
- 走读 AgentHarness。
- 走读 stdio/HTTP MCP 生命周期。
- 学 prompt injection、tool poisoning、memory poisoning、SSRF。

验收：能回答“怎么证明优化有效”和“MCP 工具为什么不能直接信任”。

### 第 4 周：后端化与模拟面试

- timeout、retry、限流、异步任务、观测和成本。
- 练习把单机 CLI 改造成多用户服务的架构题。
- 按 `INTERVIEW_QA.md` 逐题口述，不背句子，只讲逻辑。
- 准备一次 10 分钟项目演示和一次 20 分钟深挖。

验收：随机抽题时能先给结论，再结合项目代码说明，最后主动讲局限。

## 12. 面试前自检

以下问题如果不能脱离文档回答，就说明还没学会：

- Agent 和普通 Workflow 有什么区别？
- 模型为什么不能直接操作文件？
- Tool Calling 为什么还需要 schema 和权限？
- 为什么要限制最大步骤并检测重复决策？
- Context、Memory 和 RAG 分别是什么？
- recall 与 rerank 有什么区别？
- 真实 embedding 比本地哈希向量解决了什么，又引入了什么问题？
- Agent Harness 如何证明一次优化有效？
- offline eval 为什么不能完全代表线上效果？
- MCP 与 Function Calling 有什么区别？
- MCP Server 返回只读 annotation，为什么本地仍需权限策略？
- 恶意网页或 README 如何攻击 Coding Agent？
- 为什么 Plan 模式必须有运行时硬限制？
- 如果把项目改成多用户服务，哪些模块必须重做？
- 当前项目最真实的三个不足是什么？

## 13. 暂时不用深挖

除非目标转向算法岗，否则当前不必优先投入：

- Transformer 复杂数学推导。
- 从零预训练大模型。
- RLHF/DPO 训练实现。
- LoRA 和全参数微调实操。
- CUDA 和推理引擎内核优化。
- 大规模分布式训练。

这些知识不是没价值，而是不能替代你对当前 Agent 工程的真实理解。

## 14. 稳妥的面试定位

可以这样概括自己的能力边界：

> 我不是把自己包装成大模型算法工程师，而是围绕一个真实 Coding Agent 项目，系统补齐了结构化输出、工具调用、任务编排、上下文记忆、RAG、评测、安全和 MCP 等 AI 应用工程知识。我的重点是把模型能力变成可控、可测、可审计的工程系统。

这比说“我精通 Agent”可信，也比说“我只是调用 API”更准确。
