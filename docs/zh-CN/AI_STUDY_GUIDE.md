# AI 知识补习指南

这个文档只回答一个问题：

> 为了把 `mini-coding-agent` 讲明白、改明白、继续做下去，你到底需要系统补哪些 AI 知识？

结论先说：

**需要补，但不需要一上来就扎进很重的数学推导。**

对于你现在这个项目，最重要的不是先会手搓 Transformer，而是先把“如何把模型变成一个可靠的工程系统”学明白。

## 学习目标

你需要达到的不是“AI 研究员水平”，而是：

- 知道大模型为什么会胡说
- 知道 Agent 为什么会跑偏
- 知道上下文为什么会失效
- 知道 tool call 为什么经常出错
- 知道如何设计 prompt、memory、routing、evaluation 来让系统更稳

## 最该补的 6 个主题

### 1. LLM 基础认知

你至少要理解这些概念：

- token 是什么
- context window 是什么
- temperature / top_p 大概影响什么
- 模型为什么会幻觉
- 为什么模型会“看起来懂，其实在猜”
- 为什么长上下文会让回答质量下降

你不一定现在就去推公式，但这些概念一定要会用工程语言讲出来。

**你做这个项目时会直接用到：**

- 为什么要截断上下文
- 为什么要做 session summary
- 为什么要把工具结果结构化塞给模型
- 为什么不同模式要有不同 system prompt

### 2. Prompt Engineering 与结构化输出

这是你眼下最需要掌握的。

重点包括：

- system / user / tool message 的职责区别
- 如何要求模型输出 JSON
- 为什么要做 schema 校验
- 当模型输出格式错了，如何做 repair / retry
- 如何把“不要猜”写进 prompt，而不只是口头希望它别猜

**你项目里的对应模块：**

- `OpenAICompatibleClient`
- `DecisionParser`
- `WebQuestionPlanner`
- `CodeReview` 结构化输出与复核

### 3. Agent Loop 与工作流编排

这个主题和你的项目最贴。

你要理解：

- planner / executor / verifier 是什么
- 一轮 loop 中为什么要有 step 限制
- 为什么要记录 tool result / command result / patch result
- 为什么失败日志要回灌进上下文
- 为什么要防止 agent 重复同一决策

**你项目里的对应模块：**

- `AgentLoop`
- `AgentState`
- `ContextBuilder`
- `PermissionManager`

### 4. RAG 与检索增强

严格说，你当前项目还不算真正做了成熟 RAG。

你现在有的是：

- 仓库扫描
- 文件读取
- 搜索代码
- session memory
- web search / fetch

这是一种“轻量检索增强”，但还不是真正的：

- chunking
- embedding
- vector retrieval
- reranking
- evidence selection

你下一步该补的重点不是马上上向量数据库，而是先理解：

- 为什么需要 chunk
- 为什么需要召回 + 重排
- 为什么只把“相关上下文”给模型会更稳
- 为什么证据和回答要绑定

### 5. Evaluation 与可观测性

很多人做 Agent 卡住，不是因为不会写，而是因为不知道怎么证明它变好了。

你至少要懂：

- 什么是 regression test
- 什么是 golden case
- 什么是 offline eval
- 什么是 task success rate
- 什么是 tool success rate
- 什么是 hallucination / unsupported claim

**你项目下一步很适合做：**

- 固定一批路由样例
- 固定一批 web 问答样例
- 固定一批 code review 样例
- 固定一批 patch / command / repair 样例

这样每次改 prompt 或改逻辑，都能知道是变好还是变差。

### 6. 工程安全与权限边界

这个主题经常被忽略，但做 coding agent 必须懂。

你至少要理解：

- 为什么命令执行必须有风险拦截
- 为什么 patch 不能直接盲打
- 为什么要限制 repoPath
- 为什么联网抓取要受限
- 为什么 session / event / log 要留痕

这部分并不“学术”，但它决定你的项目像不像一个认真做的 Agent。

## 哪些 AI 知识暂时不用深挖

下面这些不是没用，而是**不是你当前阶段的第一优先级**：

1. 复杂的 Transformer 数学推导
2. 从零训练大模型
3. RLHF 训练细节
4. LoRA / 全量微调实操
5. 推理引擎优化
6. 多机分布式训练

如果你未来想往算法岗走，这些当然重要。

但如果你现在目标是：

- 把项目做扎实
- 面试时讲明白
- 知道如何持续迭代 Agent

那先别把精力花散。

## 推荐学习顺序

建议按这个顺序来：

### 第一阶段：先把你手上的项目讲明白

重点：

- LLM 基础概念
- Prompt 与 JSON 输出
- Tool calling
- Agent loop
- Context / memory

目标：

- 你能解释为什么项目要这么设计
- 你能指出现在为什么不够稳
- 你知道下一步该改哪里

### 第二阶段：补检索和评测

重点：

- RAG 基础
- chunk / recall / rerank
- eval 设计
- 结果引用与证据约束

目标：

- 你能把“会用模型”升级为“会做可靠的 AI 系统”

### 第三阶段：再决定要不要往更深层走

看你后面想投什么岗位：

- 偏应用工程：继续做 agent / workflow / product integration
- 偏后端平台：做多模型接入、监控、缓存、限流、任务编排
- 偏算法：再去补训练、微调、推理优化

## 和这个项目强相关的必会词汇

你最好都能解释：

- function calling
- structured output
- prompt routing
- tool grounding
- session memory
- context compression
- retry / repair
- hallucination
- evidence-based answering
- regression eval
- human-in-the-loop

## 面试里怎么说最稳

你可以这样说：

> 我没有把自己包装成算法专家，但我系统补了 AI Agent 的工程知识，重点放在任务路由、上下文管理、结构化输出、工具调用、评测回归和安全边界上。这个项目本质上是把大模型能力工程化，而不是只做一个 API demo。

这句话是很稳的。

## 你的现实学习建议

如果只给你 2 到 4 周，我建议你优先做三件事：

1. 把本项目所有核心模块讲熟
2. 把上面 6 个主题补到“能解释 + 能落地”
3. 一边学一边继续改项目，而不是学完再改

这样进步最快，也最容易在面试里形成闭环。
