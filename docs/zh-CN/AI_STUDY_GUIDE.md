# AI / Agent 工程学习指南

> 最近核对：2026-08-03。项目事实来自当前源码与 `pnpm verify`；外部知识优先引用官方文档、协议规范和原始论文。

这份文档不负责继续堆项目功能，而是回答两个问题：

1. 为了真正理解 `mini-coding-agent`，需要学习哪些知识？
2. 面试官沿着项目追问时，怎样才算不是只会背文档？

项目当前已经够用于简历和演示。接下来的主要风险不是“功能不够”，而是代码大量由 AI 辅助完成后，候选人无法解释模块为什么存在、方案有什么取舍、失败时如何定位。学习目标因此不是成为大模型算法研究员，而是具备 **AI 应用工程 + Agent 工程 + 后端工程** 的完整解释能力。

### 文档基线

本指南已按 2026-08-03 当前工作区实现同步，学习时应以以下事实为准：

- Direct、Web、Review、Repository Analysis、Change 和混合任务都以 `AGENT_TASK` 共用一个 `AgentLoop`，不存在按模式拆分的任务执行器。
- CLI 先由模型把请求与 Conversation 编译为 Schema 校验的 `TaskFrame`；源码中已经删除 `TaskRouter`、`TaskUnderstanding`、`TaskContractBuilder` 和公开控制面开关。
- `AgentTaskContract` 通过 `adaptationPolicy` 区分 `ADAPTIVE` 与 `FIXED_READ_ONLY`。
- `CapabilityNegotiator` 把模型选择的 Tool、Patch、Command 或 Delegate 动作转换为能力申请，并在同一 AgentLoop 内保持、升级或拒绝。
- 自适应合同会向模型展示安全的“可申请工具”；工具可见不等于已经获准执行。
- `PLAN`、TaskFrame 的显式只读/禁网/禁命令约束是确定性边界；补丁、命令、路径和网络仍由本地安全层检查。
- `read_file` 会自动收敛过大的分页提示，真正的输入错误会返回具体字段和约束。
- Capability Registry 把模型可调用的 `tools` 与顶层 Decision `actions` 分开；`APPLY_PATCH` / `RUN_COMMAND` 不是伪工具，协议错误会返回可恢复的精确诊断。
- Patch 的 CREATE / MODIFY / DELETE 先按工作区文件事实判定，Git tracking 只负责 diff 上下文和版本控制；空补丁、重复创建和上下文不匹配具有不同错误码。
- 修改效果使用 `NONE / CONDITIONAL / REQUIRED` 三态语义；Completion Contract 消费 TaskFrame 和执行证据，不再重新扫描原始问句。
- 验证来源区分 `USER_REQUIRED` 与 `TASK_INFERRED`。独立 HTML、JSON 和 classic JavaScript 可由只读 `verify_file` 做类型兼容验证，不能把 `node --check page.html` 之类的无效命令当成完成证据。
- 模型通过 `TaskFrame.webEvidencePolicy` 选择普通、多源、当前或高风险证据等级，并判断查询是代表性还是排名范围；本地策略表映射具体门槛，Guardrail 不再从原始问句正则推断证据等级或排名意图。
- Web 最终综合预留具有确定性降级终止：证据不足时交付部分结论、缺口和已检查来源，不再依赖模型自行退出循环。
- `fetch_url` 可依据 HTTP 或 HTML meta 解码 GB2312 / GBK / GB18030 中文页面；正式 Search API 与来源页抓取能力是两个独立问题。
- 架构回归已验证同一个 `AGENT_TASK` 可以依次 Web、读取、Patch、Command 验证并完成，并覆盖仓库内绝对路径读取、过大分页参数自动收敛、模型驱动长会话取证与逐 MCP Tool 授权。
- TaskFrame 结构错误会做一次有界自修；仍无效则 AgentLoop 在任何动作前 fail closed，不能让猜测合同把原有文件误报成本轮产物。
- TaskFrame、Agent Decision 与最终回答使用不同的输出预算；推理型模型若返回空内容或不支持当前 thinking 参数，只进行有界降级，不把增加 token 上限当成协议正确性的替代品。
- 循环保护同时识别连续重复和“两个失败动作交替出现但没有新增证据”的周期，避免只靠最大步数兜底。
- 当前确定性基线以 `pnpm verify` 当次输出为准；该命令同时检查源码可达性、文档引用、干净构建、未使用声明和完整测试集，不在学习文档中写死易过期的测试数量。

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
| P1 | 模型训练与对齐概览 | 能解释预训练、SFT、偏好优化和推理阶段的关系，不要求从零训练 |
| P2 | 多模态与推理部署 | 理解文本以外输入、量化、吞吐和延迟，按岗位选择深度 |

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

### 2.1 从 Transformer 到可调用模型

不需要先推导全部矩阵公式，但要建立正确的层次：

```text
tokenization
-> embedding + positional information
-> repeated Transformer blocks (attention + feed-forward)
-> next-token probability
-> pretraining
-> supervised instruction tuning (SFT)
-> preference alignment (例如 RLHF / DPO)
-> inference-time sampling / reasoning / tool use
```

至少要理解：

- Attention 让一个 token 根据其他 token 的表示计算新的上下文表示；Transformer 不等于“拥有数据库”或“保证事实正确”。
- 预训练主要学习语言与世界模式，SFT 教模型按指令完成任务，偏好对齐优化回答风格与人类偏好；三者不能代替运行时权限和事实验证。
- RLHF 通常涉及偏好数据、奖励模型与强化学习；DPO 用更直接的偏好目标简化训练。面试重点是它们解决什么，不是手写训练框架。
- reasoning effort、temperature、输出 token 上限属于推理阶段配置，不会扩大模型的训练知识，也不会自动修复错误 Tool Schema。
- embedding model、reranker、生成模型和多模态模型承担的任务不同，不能只按参数量或排行榜选型。

推荐从原始资料建立概念，再用可视化课程补直觉：

- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)：先读摘要、架构图和 attention 章节。
- [Training language models to follow instructions with human feedback](https://arxiv.org/abs/2203.02155)：理解 SFT、偏好数据、奖励模型和 RLHF 流程。
- [Direct Preference Optimization](https://arxiv.org/abs/2305.18290)：理解它相对传统 RLHF 简化了什么。
- [Hugging Face LLM Course](https://huggingface.co/learn/llm-course/chapter1/1)：用于补 tokenizer、Transformer、微调和常用工具链实践；它是辅助教材，不替代论文与项目验证。

学会标准：能用三分钟解释“一个基础模型如何变成能遵循指令、调用工具的应用模型”，并明确哪些能力来自模型训练，哪些来自 Agent Runtime。

## 3. Structured Output 与 Tool Calling

### 必须理解

- Function Calling / Tool Calling 的基本过程。
- JSON Schema 如何向模型描述工具输入。
- Structured Output 与“Prompt 里要求输出 JSON”的区别。
- 为什么模型输出必须做运行时校验。
- parse、repair、retry、fail closed 与显式预编译合同的区别。
- 参数合法、权限允许、执行成功是三个不同层级。
- Tool Calling 是模型选择能力；真正执行仍由宿主程序完成。

### 项目对应

- `AgentDecision`
- `DecisionParser`
- `Tool`
- `ToolRegistry`
- Zod input schema
- `TaskFrame`
- `TaskFrameResolver` 的严格语义 Schema 与 `webEvidencePolicy`
- `AgentDecision`、Tool input 与 SubAgent protocol 的分层校验
- `CapabilityNegotiator` 的动作到能力映射
- `TaskFrame.constraints`、`AgentOperatingMode` 与 `TaskGuardrails` 的显式只读安全边界

### 典型追问

> 已经要求模型输出 JSON，为什么还需要 Zod？

模型输出属于不可信外部输入。JSON 语法正确不代表字段完整、类型正确或满足业务约束；Zod 用于运行时校验并把失败包装成结构化错误，避免错误参数直接进入文件、命令或网络执行层。

还应能区分“模型参数偏好”和“安全约束”。例如 `read_file.maxLines`、`maxTokens` 过大只表示模型希望读取更多内容，运行时会自动收敛到内部上限；路径越界、负数分页或错误类型才是应当拒绝的输入。校验失败信息必须包含具体字段，不能只给模型一个无法恢复的“input invalid”。

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
- 初始意图标签、当前能力、可申请能力和不可突破安全约束之间的区别。
- 为什么模型动作可以申请能力，但不能自行绕过 Permission、Sandbox 和 Guardrail。

### 项目对应

- `TaskFrame`
- `TaskFrameResolver`
- `TaskFrameContract`
- `AgentLoop`
- `AgentState`
- `CapabilityNegotiator`
- `TaskFrame.constraints`
- `TaskGuardrails`
- `AgentOperatingMode`
- `Plan` 模式
- `IsolatedSubAgentCoordinator`
- `SubAgentWorktree`

`AgentTaskContract` 仍需理解，但它现在只保存当前授权、证据和不可突破约束，不再保存 Direct/Web/Edit 路由结果。旧 Session 结果字符串只用于持久化数据读取兼容。

### 项目循环

```text
用户任务
-> 创建中性 bootstrap contract
-> AI 根据请求与 Conversation 生成 TaskFrame
-> 编译 AGENT_TASK 的效果、约束与完成条件
-> 展示已启用工具和可申请的安全只读工具
-> 构建上下文
-> LLM 返回结构化 decision
-> Capability Negotiator 推导动作所需能力
-> 保持、升级或拒绝当前合同
-> 本地校验和执行
-> 记录 observation / error / diff
-> 回到下一轮
-> FINAL 或触发终止条件
```

Direct、Web、Review、Repository Analysis 与 Change 不是五套循环。它们都使用 `AGENT_TASK`；`TaskFrame` 给出所需效果和完成条件。模型选择 `web_search`、`APPLY_PATCH`、`RUN_COMMAND` 或 `DELEGATE` 本身就是能力申请；Negotiator 可以在同一 State、Session 和事件流内组合授权，任务 kind 不需要切换。Plan 使用 `FIXED_READ_ONLY`；普通执行中的显式只读要求由 `TaskFrame.constraints` 形成同样不可突破的动作边界。

多 Agent 也不是循环外脚本：父 Agent 通过 `DELEGATE` 创建依赖任务，Writer 在临时 worktree 迭代，Reviewer 读取物化补丁，父级保留合入权。

### 规则与模型的职责边界

- 模型负责结合当前请求、对话和证据解释“用户现在想做什么”，并选择下一步动作。
- TaskFrame 是模型语义编译结果，不是本地关键词产生的 Direct/Web 模式标签。
- TaskFrame 的非安全资源偏好先做边界归一化，结构错误执行一次模型自修；修复仍失败会在动作前终止。程序化调用方只能通过显式传入已验证合同跳过编译。
- Capability Negotiator 根据动作声明组合能力，不按特定问句编写“如果用户说 X 就切到 Y”。
- 本地确定性规则只承担安全、显式用户约束、输入结构和产品事实，不在多个阶段重复猜测开放式意图；完成条件只消费 TaskFrame 和实际执行证据。
- 多轮 Conversation 同时携带助手原话和运行时执行账本；旧文件存在或被读取不等于上一轮创建，仓库效果只以成功 Patch / `FILE_CHANGE` 为准。
- Web、知识库、仓库读取和写入是可组合能力；复合任务可以在一个合同/循环中同时要求检索证据和代码变更，纯查询才固定只读。
- 多轮追问不继承上一轮 `WEB_ANSWER` 或 `AGENT_LOOP` 模式；当前 TaskFrame 和模型动作决定本轮能力。

### 典型追问

> 为什么 Agent 不能一直执行到成功？

因为模型可能重复同一个错误、不断消耗 token、持续修改错误方向，甚至放大危险操作。最大步数、重复决策检测和连续失败限制是成本、稳定性和安全性的硬边界。

> 为什么 Web 搜索结束后还能继续修改代码？

因为 Web 只是 `AGENT_TASK` 的一个效果，不是另一套执行器。模型在研究后选择 `APPLY_PATCH`，Capability Negotiator 会在原合同上增加仓库写入授权并保留 Web 证据；任务 kind 不发生切换，补丁仍需通过读取证据、Patch check、Permission 和完成条件。

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
- 多轮任务：Conversation 用于解释当前指代，但不会直接复制上一轮任务模式；历史 `WEB_ANSWER` 不能把“继续优化”锁成 Web 回答。

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
- `KnowledgeIndexTool`
- `KnowledgeSearchTool`
- `RagEvaluator`
- `MemoryQueryBuilder`
- `MemoryRetriever`
- `MemoryReranker`
- `MemoryEvidenceSelector`
- `EmbeddingProvider`
- `TaskFrame.webEvidencePolicy` 与 `TaskGuardrails` 的 Web evidence assessment

### 当前已经实现

- 文档、源码和配置文本使用扩展名白名单安全导入；二进制拒绝、按行 chunking、overlap 和来源 hash。
- 独立于长期记忆的 `.mini-agent/rag/index.jsonl` 文档索引。
- 按来源增量替换、来源/标签过滤、Top-K、来源多样性和上下文预算。
- 关键词与向量混合检索、文件行号 citation 和证据不足拒答。
- answerability accuracy、hit rate、Recall@K、MRR 离线评测。
- 中英文关键词和本地离线 embedding。
- 可选 OpenAI-compatible embedding provider。
- Agent 原生空索引与陈旧索引恢复：search 返回候选前重新核对选中源文件的实时 `sourceHash`；收到 `EMPTY_INDEX` 或 `STALE_INDEX/staleSources` 后，对相关仓库路径执行受权的 `knowledge_index`，再 search，并用刷新后的真实 citation 完成回答。
- query building、候选召回、rerank、evidence selection。
- TTL、confidence 和同主题记忆替代。
- Web 回答在没有可读正文时拒绝给出确定性实时结论。

### 当前仍不是生产级 RAG 的原因

- JSONL 存储不适合大规模并发和高数据量。
- 切换 embedding 模型后能检测 provider 不匹配并要求重建，但仍缺少批量迁移工具。
- 没有 cross-encoder reranker、查询改写、PDF/OCR 和结构化表格解析。
- JSONL 单机索引不提供数据库级事务、文档 ACL 和多租户隔离。
- 同主题冲突主要基于标题，不是强语义冲突检测。
- 严格 Web 回答已用结构化 `webClaims` 记录逐 claim 的来源关联，并验证 URL 抓取血缘与最终可见性；尚未用 NLI/LLM Judge 自动证明来源正文对结论的语义蕴含。

### 学会标准

能画出完整 RAG 链路，能解释 recall 与 rerank 的区别，并能诚实指出当前项目和生产级知识库之间的差距。

### 6.1 Skill 与渐进式上下文注入

Skill 不是新的 Agent 模式，也不应该靠“用户问句命中某个硬编码词”才能存在。它解决的是：如何把可复用工作流、约束和参考资料按需提供给模型，同时避免把所有长说明永久塞入 Prompt。

项目当前采用两阶段注入：

1. `SkillStore` 扫描仓库 `skills/*/SKILL.md` 与本地 `.mini-agent/skills/*/SKILL.md`，校验 frontmatter、名称、长度、真实路径和目录边界。
2. `ContextBuilder` 总是注入有界的 Skill catalog，只包含名称、描述、来源和资源数量；这让模型可以做语义发现，而不是完全依赖词法预选。
3. 对显式 `$skill-name` 或明显匹配项，仍可注入一份有界的预选说明，降低常用路径的调用成本。
4. 模型真正决定使用某项 Skill 时，通过只读 `skill_read` 分页读取完整 `SKILL.md`，并按需读取该目录下已经发现和验证的文本资源。
5. 二进制、超大资源、符号链接和目录逃逸不会进入可读资源列表；Skill 指令优先级低于系统 Prompt、当前用户目标、Task Contract、权限和仓库事实。

这体现了 progressive disclosure：先给低成本目录，再按语义选择加载高成本内容。它比一次性注入所有 Skill 更节省 Context，也比只靠正则/关键词路由更通用。当前边界是声明式文本工作流，不执行 Skill 中的任意代码，不提供远程市场或依赖安装。

学习时要能回答：Skill catalog 为什么属于发现元数据？`skill_read` 为什么仍需要路径边界？为什么外部 Prompt 或 Skill 文本不能获得 system message 的优先级？

## 7. Agent Evaluation 与 Agent Harness

### Harness 是什么

Agent Harness 不是一种 Agent 算法，而是承载 Agent 运行、构造场景、注入依赖、采集轨迹和计算指标的测试框架。它解决的是：

> 修改 Prompt、路由或工具描述以后，如何证明 Agent 真的变好了，而不是只在一次人工演示中碰巧成功？

### 必须理解

- unit test、integration test、end-to-end test。
- regression set 与 golden case。
- offline eval 与 online eval。
- deterministic scripted model 与 real-model sampling。
- pass@1、pass@k、run pass rate、all-runs pass rate；理解“至少一次成功”为什么可能掩盖 flaky。
- 二项比例的 95% Wilson 置信区间；小样本 100% 不等于真实成功率已经确定为 100%。
- tool selection accuracy、tool execution success rate。
- 平均步骤、平均 LLM 调用、token cost、latency。
- unsupported claim rate。
- failure taxonomy：模型、工具、权限、循环保护、步数上限、期望不匹配；分类应消费结构化 `failureCode`，不能通过错误文本关键词猜测。
- 数据集污染、过拟合固定 case 和 flaky eval。

### 项目对应

- `ScriptedLlmClient`：返回预设 decision，保证离线回归可重复。
- `AgentHarness`：创建临时 git 仓库、运行 AgentLoop、检查 diff 和文件。
- `runSuite`：汇总成功率、平均步骤、工具选择准确率和失败分类。
- `AgentBench`：重复真实模型采样，报告全轮通过率、flaky 场景、Wilson 区间、成本与延迟，并通过 `bench compare` 比较历史报告。
- `real-model-acceptance-v1` 与 `bench accept`：固定三类真实模型验收目标，默认重复三轮，同时生成机器可读 JSON 和面试/复盘可读 Markdown；报告文件不作为跨模型永久基线自动提交。
- Vitest：固定语义/契约、Web、Review、Patch、Command、Context、子 Agent、Memory、RAG、Skill 和 MCP 回归。
- `CapabilityNegotiator.test.ts`：验证动作驱动升级、可申请工具发现和固定只读边界。
- `AgentLoop.test.ts` / `cli-regression.test.ts`：覆盖 Web 到写入的同循环升级、短追问和真实文件结果。

### 当前回归重点

- TaskFrame Schema、有界自修、AgentLoop fail-closed 和结构化 Web evidence policy。
- `read_file` 仓库内绝对路径、大参数自动收敛和完整分页覆盖。
- 同一 `AGENT_TASK` 的 Web/读取/写入/命令组合。
- TaskFrame 只读阻断、MCP 精确授权、RAG 空索引恢复、Skill 渐进读取和最终完成证据。
- 旧配置字段只能被迁移丢弃，不能重新启用另一条执行链。
- 涉及真实子进程的 Command/MCP 测试在受限环境可能出现 I/O 资源竞争；若单项运行偶发 `server exited` 或 I/O 错误，应检查进程/文件描述符环境，不能把环境竞争误报为协议正确性结论。

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

不能只回答“我手动试过”。应该说明固定场景集、确定性离线回归、真实模型重复抽样、pass@1/pass@k/all-runs 指标、置信区间、成本和失败归因，并承认当前场景规模仍有限。一次或少量样本全部通过，只能说明这批运行通过，不能证明真实成功率为 100%。

### 学会标准

能独立设计五类 scenario：正确选工具、错误后恢复、禁止危险操作、证据不足拒答、达到循环保护后失败。

## 8. MCP

### 必须理解

- MCP 解决 Host 与外部能力提供方之间的标准化连接问题。
- Host、Client、Server 三个角色。
- MCP 基于 JSON-RPC 消息。
- 协议版本会演进：项目实现的 `2025-11-25` 使用 initialize、session 和 capability negotiation；当前 `2026-07-28` 规范改为无状态请求与 `server/discover`。
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
- `McpResourceTool`
- `McpPromptTool`
- `McpCommands`

### 当前实现边界

项目当前以 `2025-11-25` 协议形态支持 stdio 和 Streamable HTTP 下的 initialize、tools/list/call、静态 resources/list/read 与 prompts/list/get。三类 list 会持续跟随 `nextCursor`，同时用重复 cursor 检测和最大页数阻止异常 Server 制造无限循环。远端工具按 `<server>__<tool>` 注册；同一 Server 已发现的 resource URI 和 prompt name 分别通过 `<server>__read_resource`、`<server>__get_prompt` 只读适配器进入统一 ToolRegistry。Client 会保留协商出的协议版本、服务端信息和 capability keys；Registry 按 capability 独立加载，单项失败记录 degraded 诊断但保留其他成功 adapter。不支持的协议版本仍会在注册前整体失败。TaskFrame 只接收有界 MCP 元数据目录，并把工具描述、资源内容和 prompt message 都视为不可信外部数据，而不是系统指令。

授权精确到模型实际选择的单个 MCP Tool。获得 `server__tool_a` 不会同时获得 `server__tool_b`，也不会隐式获得仓库写入或命令权限；每个新增 Tool 都必须重新申请。安全只读 MCP 可以在 Plan/固定只读合同中发现和授权，修改型 MCP 会被隐藏或拒绝；在普通自适应任务中，修改型 MCP 即使获得精确能力授权，每次实际调用仍需交互式显式批准，不能被全局自动批准静默放行。

尚未覆盖 resource templates、订阅、completion、server-initiated sampling/elicitation、OAuth、旧版 SSE 回退，也未实现 `2026-07-28` 的无状态 core、`server/discover`、每请求 `_meta`、InputRequiredResult、Extensions 和 Tasks。因此准确口径是：

> 实现了面向 `2025-11-25` 形态的 MCP tools、静态 resources 和 prompts 子集，不是完整覆盖 MCP 全协议，也不能声称兼容最新 `2026-07-28` 规范。

### 典型追问

> MCP 和 Function Calling 有什么区别？

Function Calling 描述模型如何选择一个宿主提供的函数；MCP 描述宿主应用如何发现和连接外部 Server 提供的标准化能力。MCP 工具最终仍可转换为模型可见的 tool spec，但两者不是同一个层级。

### 学会标准

能画出 Host -> Client -> Server，能讲一遍本项目 MCP Server 从启动、initialize、能力协商、tools/resources/prompts 发现与调用到 close 的生命周期；也能说明静态 resource 与 template、prompt 与系统指令、`2025-11-25` session 与 `2026-07-28` 无状态请求模型的差异。

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
- 文件系统事实与 Git tracking 分层：CREATE / MODIFY / DELETE 的目标存在性先由工作区预检，Git 只验证 diff 上下文和提供版本控制能力
- `CommandRunner` 的危险命令拦截
- `FetchUrlTool` 的私网和重定向限制
- Plan 模式的工具暴露与运行时双重限制
- `TaskFrame.constraints`、`TaskGuardrails` 与 `FIXED_READ_ONLY` 的不可升级边界
- `CapabilityNegotiator` 只授予能力、不代替 Permission 和 Sandbox
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

### 10.1 完整知识地图：知道自己缺哪一层

不要把“AI 知识”看成一条无限长的列表。对 AI 应用工程岗位，可以按六层定位缺口：

| 层 | 核心问题 | 最小产出 |
| --- | --- | --- |
| 模型基础 | token、attention、训练与推理如何连接 | 画出从文本到 next-token prediction 的数据流 |
| 模型接口 | 如何得到稳定、结构化、可观测的输出 | 写一次带 Schema、重试、usage 和超时的调用 |
| 检索与数据 | 模型如何使用外部、私有和最新知识 | 做一组可测的 RAG 查询并计算 Recall@K / MRR |
| Agent Runtime | 模型如何在环境反馈中多步行动 | 实现 decision -> action -> observation -> stop |
| 安全与评测 | 如何限制权限并证明没有回归 | 为危险动作、证据不足和循环失败建立 scenario |
| 服务化 | 如何承载并发、状态、成本与故障 | 设计队列、存储、限流、trace 和租户隔离 |

学习顺序遵循“概念 -> 本项目源码 -> 最小实验 -> 指标 -> 口述”。如果一项知识没有对应实验或解释目标，先不要继续收集课程。

## 11. 推荐学习资料与阅读顺序

下面只收录官方文档、协议规范和原始论文。很多二手教程会把“Agent”“工作流”“Function Calling”和“MCP”混为一谈，适合入门但不适合作为面试口径。英文资料不需要逐字翻译，先带着右侧的问题阅读，再回到项目代码验证。

资料状态核对日期为 **2026-08-03**。涉及模型、API 和协议版本时，不要把“当前网页内容”永久写成项目能力；应同时核对项目代码、依赖版本和测试结果。特别是 MCP 已在 `2026-07-28` 发布正式规范，而本项目仍有意保持较小的 `2025-11-25` tools/static resources/prompts 子集，实现事实与最新学习材料必须分开表述。

### 11.1 第一轮必读

| 顺序 | 资料 | 阅读重点 | 回到项目验证 |
| --- | --- | --- | --- |
| 1 | [Building Effective AI Agents（Anthropic）](https://www.anthropic.com/engineering/building-effective-agents) | Workflow 与 Agent 的区别、何时使用简单组合模式、Agent 如何根据环境反馈自主选择工具 | `TaskFrame`、`AgentLoop`、`CapabilityNegotiator` |
| 2 | [Function Calling（OpenAI）](https://developers.openai.com/api/docs/guides/function-calling) | 工具声明、模型返回 tool call、宿主执行、tool result 回灌的完整循环 | `AgentDecision`、`ToolRegistry`、`AgentLoop` |
| 3 | [Structured Outputs（OpenAI）](https://developers.openai.com/api/docs/guides/structured-outputs) 与 [JSON Schema 入门](https://json-schema.org/learn/getting-started-step-by-step) | Schema 约束解决什么、仍需做哪些本地校验、结构正确与执行获准为何不是一回事 | `DecisionParser`、Zod schema、Tool input validation |
| 4 | [ReAct 原始论文](https://arxiv.org/abs/2210.03629) | 推理与行动交替、Observation 如何改变后续计划、错误如何传播 | `AgentLoop` 的 decision -> action -> observation；不要求展示隐藏思维链 |
| 5 | [Effective Context Engineering for AI Agents（Anthropic）](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Context 是有限资源、信息选择和压缩、长任务中的上下文维护 | `ContextBuilder`、`MessageCompressor`、Memory 模块 |
| 6 | [RAG 原始论文（NeurIPS 2020）](https://papers.neurips.cc/paper_files/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html) 与 [Vector Embeddings（OpenAI）](https://developers.openai.com/api/docs/guides/embeddings) | 参数化记忆与外部记忆、dense retrieval、向量相似度；不要把原始 RAG 论文等同于所有现代 RAG 工程 | `RagStore`、`EmbeddingProvider`、Retriever / Reranker / EvidenceSelector |
| 7 | [Demystifying evals for AI agents（Anthropic）](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | task、trial、grader、transcript、outcome、harness；能力评测与回归评测的区别 | `AgentHarness`、scenario、failure taxonomy、真实 CLI 回归 |
| 8 | [MCP Architecture 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/architecture) 与 [MCP Tools 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | 当前无状态协议、每请求能力信息、`server/discover`、`tools/list`、`tools/call`；再与项目的 2025-11-25 实现比较 | `McpClient`、`McpRegistryLoader`、`McpRemoteTool` |
| 9 | [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/) | Prompt Injection、Improper Output Handling、Excessive Agency、敏感信息和供应链风险 | Permission、Path、Command、Web、Memory 和 MCP 安全边界 |
| 10 | [Responses API 与 Agents SDK（OpenAI）](https://developers.openai.com/api/docs/guides/agents#compare-the-responses-api-and-agents-sdk) | 自己维护循环与使用 SDK lifecycle 的边界、handoff、guardrail、state 和 tracing | 对比本项目自研 `AgentLoop`，说明哪些能力由 Runtime 自己承担 |

如果时间有限，先完成前 5 项。读完后应能解释：模型为什么能自主选工具，为什么初始分类不能锁死整个任务，以及为什么安全授权仍必须由确定性代码控制。

### 11.2 按主题精读

#### LLM、Token 与上下文

- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)：建立 Transformer 基础，不要求第一次就推完公式。
- [Counting tokens（OpenAI）](https://developers.openai.com/api/docs/guides/token-counting)：理解输入、输出和工具 Schema 都会占用上下文预算。
- [Compaction（OpenAI）](https://developers.openai.com/api/docs/guides/compaction)：观察长任务怎样压缩状态；阅读时对照本项目的 `MessageCompressor`，不要假设两者实现相同。
- [Production best practices（OpenAI）](https://developers.openai.com/api/docs/guides/production-best-practices)：关注密钥、请求扩容、延迟和成本，而不是照搬某个厂商接口。
- [Model optimization（OpenAI）](https://developers.openai.com/api/docs/guides/model-optimization)：理解 eval、prompt、fine-tuning 的迭代顺序，不要遇到失败就直接微调。

读完后的练习：给 `ContextBuilder` 画一张输入优先级表，并说明超预算时先舍弃什么、为什么。

#### Tool Calling 与可恢复错误

- [Function Calling（OpenAI）](https://developers.openai.com/api/docs/guides/function-calling)：重点画出模型和宿主之间的往返，而不是只抄函数定义示例。
- [JSON Schema 入门](https://json-schema.org/learn/getting-started-step-by-step)：掌握 `type`、`properties`、`required`、数组约束和嵌套结构。
- [MCP Tools 的 Error Handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)：区分 malformed request 的协议错误、可反馈给模型自我修正的执行错误与需要额外输入的结果。

读完后的练习：分别构造 `read_file` 的错误类型、越界路径、负数分页和过大 `maxLines`，说明哪些应拒绝、哪些应自动收敛，并检查返回信息是否足以让模型修正下一次调用。

#### Agent 架构与动态能力

- [Building Effective AI Agents（Anthropic）](https://www.anthropic.com/engineering/building-effective-agents)：先理解增强 LLM、workflow 和 agent，再判断项目中哪些部分应确定化。
- [ReAct 原始论文](https://arxiv.org/abs/2210.03629)：精读方法和实验局限，理解行动获取的新证据如何修正计划。

读完后的练习：用“先 Web 搜索、再读取仓库、最后写补丁”的任务走一遍状态变化。不得通过问句正则指定模式，只能用模型动作、能力申请、安全边界和执行结果解释。

#### RAG 与证据质量

- [RAG 原始论文（NeurIPS 2020）](https://papers.neurips.cc/paper_files/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html)：理解为什么引入可检索的非参数化记忆。
- [Vector Embeddings（OpenAI）](https://developers.openai.com/api/docs/guides/embeddings)：补齐 embedding、距离度量和典型检索用途。

读完后的练习：准备 10 个小问题，分别记录 Recall@K、MRR、最终可回答率和引用正确率；不要只观察“答案看起来不错”。

#### Agent Eval

- [Demystifying evals for AI agents（Anthropic）](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：这是当前最贴近本项目 Harness 的主材料，重点读 outcome、grader、transcript、能力评测和回归评测。
- [Working with evals（OpenAI）](https://developers.openai.com/api/docs/guides/evals)：学习如何把测试数据、grader 和运行结果组织成可重复实验。
- [SWE-bench 原始论文（ICLR 2024）](https://proceedings.iclr.cc/paper_files/paper/2024/hash/edac78c3e300629acfe6cbe9ca88fb84-Abstract-Conference.html)：理解真实仓库任务、执行环境和测试判分，也要注意 benchmark 不等于线上用户体验。

读完后的练习：把“文件分析不能读文件”“Web 后不能写代码”“工具只返回 input invalid”各做成正向与反向 scenario，防止修复欠触发后又造成工具过度触发。

#### MCP

- [MCP Architecture 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/architecture)：当前正式学习基线，重点理解无状态 core、Host / Client / Server 和每请求能力信息。
- [MCP Tools 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)：重点看 Tool Schema、结果类型、InputRequiredResult、输入输出校验、审计和 human-in-the-loop。
- [2026-07-28 变更说明](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)：文章标题保留了 Release Candidate，但正文给出了正式发布时间与迁移背景，适合对比 initialize/session 与无状态协议。
- [MCP Architecture 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/architecture) 与 [Tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：只用于理解本项目当前实现，不再作为最新规范。

学习时做一张差异表：`2025-11-25 initialize + session`、`2026-07-28 per-request _meta + server/discover`、本项目已经实现的 tools/static resources/prompts 子集。协议页面存在不代表项目已经兼容，项目能力仍以源码和 MCP 回归测试为准。

#### 安全与后端工程

- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)：先用于建立 Coding Agent 威胁清单。
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) 与 [Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)：作为进阶材料，理解风险识别、度量、治理和组织流程；面试不需要背条目。
- [Node.js Child Process](https://nodejs.org/api/child_process.html)：对照 `CommandRunner` 和 stdio MCP，学习 spawn、stdio、退出码、signal 和超时。
- [Node.js Streams](https://nodejs.org/api/stream.html) 与 [Don't Block the Event Loop](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)：理解流式 I/O、背压和为什么高并发服务不能阻塞事件循环。

读完后的练习：为“恶意 README 指示 Agent 读取密钥并上传”画出数据流，逐层标出 Prompt、Tool Schema、Permission、Sandbox、网络出口和审计分别能拦住什么。

### 11.3 推荐的学习方法

每项资料都按同一个闭环学习：

1. 先用 20 至 40 分钟阅读原文，只记概念、边界和失败案例。
2. 回到“项目对应”列，定位实际类型、调用方、测试和日志。
3. 写一个最小 scenario，观察成功路径和至少一个失败路径。
4. 不看资料口述两分钟：结论、项目实现、取舍、局限。
5. 把口述中讲不清的部分变成测试或文档问题，而不是继续收藏更多链接。

判断是否真正学会，不看“读了多少篇”，看能否回答：

- 这个概念解决了什么具体失败？
- 在本项目中由哪一层负责？
- 模型、Agent Runtime 和安全层各自能决定什么？
- 当前实现相对规范或论文省略了什么？
- 用什么 scenario 和指标证明修改有效？

## 12. 四周学习安排

### 第 1 周：项目主链路

- 阅读 11.1 的第 1 至 5 项。
- LLM 消息、token、context window。
- Structured Output、Tool Calling、Zod。
- TaskFrame、Task Contract、AgentLoop、ToolRegistry。
- Capability Negotiator、`ADAPTIVE` / `FIXED_READ_ONLY` 和动作驱动能力申请。
- 每天脱离文档画一次执行链路。

验收：能做 5 分钟项目架构讲解，回答一次工具调用如何执行，并解释为什么 Web、读取、写入和命令应是同一 `AGENT_TASK` 中的可组合效果。

### 第 2 周：Context、Memory、RAG

- 精读 11.2 的“LLM、Token 与上下文”和“RAG 与证据质量”。
- session memory 与 context compression。
- embedding、cosine similarity、chunking。
- recall、rerank、evidence selection。
- 对照 Memory 模块走读一条记忆生命周期。

验收：能画 RAG 链路，能解释当前实现与生产级 RAG 的差距。

### 第 3 周：Eval、MCP、安全

- 精读 11.2 的“Agent Eval”“MCP”和“安全与后端工程”。
- 设计 Agent scenario 和指标。
- 走读 AgentHarness。
- 走读 stdio/HTTP MCP 生命周期。
- 学 prompt injection、tool poisoning、memory poisoning、SSRF。

验收：能回答“怎么证明优化有效”和“MCP 工具为什么不能直接信任”。

### 第 4 周：后端化与模拟面试

- 复习各资料后的练习，并把真实失败案例加入 Harness。
- timeout、retry、限流、异步任务、观测和成本。
- 练习把单机 CLI 改造成多用户服务的架构题。
- 按 `INTERVIEW_QA.md` 逐题口述，不背句子，只讲逻辑。
- 准备一次 10 分钟项目演示和一次 20 分钟深挖。

验收：随机抽题时能先给结论，再结合项目代码说明，最后主动讲局限。

### 可选第 5 至 6 周：补模型基础与做独立实验

- 第 5 周读 Transformer、InstructGPT、DPO 的摘要与方法图，完成一个 tokenizer / attention 可视化笔记；目标是建立概念链，不是训练大模型。
- 第 6 周脱离本仓库做一个 200 行以内的最小 Agent 或 RAG 实验，再用同一组 eval 比较“无工具 / 有工具”“关键词 / 混合检索”“无 Guardrail / 有 Guardrail”。

验收：能区分“模型能力、提示策略、检索质量、Runtime 逻辑和基础设施”五类失败，不再把所有问题都归因于模型或架构。

## 13. 面试前自检

以下问题如果不能脱离文档回答，就说明还没学会：

- Agent 和普通 Workflow 有什么区别？
- 模型为什么不能直接操作文件？
- Tool Calling 为什么还需要 schema 和权限？
- 工具“可见”“已启用”“执行获准”分别是什么意思？
- Capability Negotiator 为什么不是另一套意图路由器？
- 为什么模型可以申请能力，却不能突破 `FIXED_READ_ONLY`？
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

## 14. 暂时不用深挖

除非目标转向算法岗，否则当前只需理解概念，不必优先投入实现细节：

- Transformer 复杂数学推导。
- 从零预训练大模型。
- RLHF/DPO 的大规模训练实现（但要能解释目标和差异）。
- LoRA 和全参数微调实操。
- CUDA 和推理引擎内核优化。
- 大规模分布式训练。

这些知识不是没价值，而是不能替代你对当前 Agent 工程的真实理解。

## 15. 稳妥的面试定位

可以这样概括自己的能力边界：

> 我不是把自己包装成大模型算法工程师，而是围绕一个真实 Coding Agent 项目，系统补齐了结构化输出、工具调用、任务编排、上下文记忆、RAG、评测、安全和 MCP 等 AI 应用工程知识。我的重点是把模型能力变成可控、可测、可审计的工程系统。

这比说“我精通 Agent”可信，也比说“我只是调用 API”更准确。
