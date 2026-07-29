# 当前架构：TaskFrame + 单一 AgentLoop

本文只描述当前源码。历史方案和迁移原因见 [架构演进记录](ARCHITECTURE_EVOLUTION.md)。

## 1. 核心结论

`mini-coding-agent` 只有一条任务执行链：

```text
User request + Conversation
  -> TaskFrameResolver（模型语义编译）
  -> TaskFrame Schema validation
  -> AgentTaskContract（当前授权与证据要求）
  -> AgentLoop
       -> ContextBuilder
       -> LlmClient
       -> AgentDecision
       -> CapabilityNegotiator
       -> Permission / Sandbox / Guardrails
       -> Tool / Patch / Command / Delegation
       -> 下一轮 AgentDecision
  -> Completion validation
  -> Session / Event / Checkpoint / Diff
```

不存在 Direct、Web、Review、Edit 等互斥运行模式，也不存在根据用户问句先选择执行器的 `TaskRouter`。普通回答是在 AgentLoop 第一次决策返回 `FINAL`；文件分析会选择 `read_file`；Web 研究会选择 `web_search` / `fetch_url`；写代码会选择 `APPLY_PATCH`。这些动作可以在同一次运行中连续出现。

因此：

- Web 搜索完成后可以直接继续读仓库、修改文件和验证，不需要切换“编辑模式”。
- 用户提供仓库内绝对路径时，`read_file` 可以读取并统一返回仓库相对路径。
- `read_file.maxLines` / `maxTokens` 过大时自动截断到安全上限，不再把无害的分页建议当成 Schema 错误。
- 旧配置中的 `controlPlane` 字段只会在加载时被丢弃，不能重新启用第二套运行时。

## 2. TaskFrame：唯一语义记录

![当前单一控制链](assets/mini-agent-current-source-flow.png)

TaskFrame 由模型结合当前请求与最近 Conversation 生成，并由 Zod 校验。主要字段如下：

| 字段 | 含义 |
|---|---|
| `objective` | 当前任务目标 |
| `target` | `REPOSITORY`、`WORLD`、`PRODUCT`、`SESSION`、`DERIVATION` 或 `MIXED` |
| `answer` | 答案形态与深度 |
| `effects` | 回答、仓库读写、Web、知识库、命令、验证、委派、MCP |
| `webEvidencePolicy` | 搜索视角数、抓取数、独立域名、引用、时效与权威来源要求 |
| `constraints` | 只读、禁网、禁命令、禁委派、禁 MCP、完整文件读取 |
| `collaboration` | 是否要求 writer、reviewer 与代理数量 |
| `conversationEvidence` | 是否需要更早历史、语义查询和最近消息窗口 |
| `completionCriteria` | 可观察的完成条件 |

TaskFrame 负责语义，不负责授权。即使模型声明需要写入或命令，运行时仍要经过 Capability、Permission、Sandbox 和 Guardrail。

TaskFrame 解析失败时使用中性 fallback：

- 保留原始用户目标；
- 不推测特殊任务类型；
- 不退回关键词路由；
- 继续让 AgentLoop 使用可发现的安全工具理解任务；
- 写入、命令、Web、MCP 和委派仍需逐动作授权。

## 3. AgentTaskContract：运行状态，不是任务模式

所有新任务的 `kind` 都是 `AGENT_TASK`。合同记录：

- 当前已经授权的能力；
- 必须满足的证据；
- 只读或 Plan 等不可升级边界；
- 精确 MCP Tool grant；
- 最大步数和任务说明；
- 当前 TaskFrame。

`CapabilityNegotiator` 根据模型实际选择的动作申请能力：

```text
TOOL_CALL read_file       -> repositoryRead
TOOL_CALL web_search      -> webAccess + Web evidence
TOOL_CALL knowledge_search -> knowledgeAccess
APPLY_PATCH               -> repositoryWrite
RUN_COMMAND               -> commandExecution
DELEGATE                  -> delegation
MCP TOOL_CALL             -> 只授权所选 <server>__<tool>
```

授权后仍是同一个 State、Session 和 AgentLoop。不存在 `WEB_RESEARCH -> REPOSITORY_TASK` 之类的模式迁移。

## 4. AI 负责什么，本地代码负责什么

### AI 负责

- 理解开放式自然语言；
- 生成 TaskFrame；
- 结合 Context 选择下一动作；
- 规划搜索、阅读、修改和验证；
- 根据工具结果迭代；
- 生成最终答案或诚实失败说明。

### 本地代码负责

- Schema 校验；
- 路径沙箱和仓库边界；
- 补丁格式、作用域与应用检查；
- 命令风险和 Permission；
- MCP 精确授权；
- Web URL 血缘；
- 完整文件覆盖；
- 修改与验证的时序；
- 多 Agent worktree 隔离；
- 最终证据与完成条件。

这条边界避免两种极端：

1. 用正则模拟自然语言理解；
2. 把权限和成功状态完全交给模型自报。

## 5. 仍然允许确定性规则的地方

项目不追求“源码里完全没有正则”。关键是规则不能决定开放式任务属于哪个执行模式。

合理的确定性规则包括：

- 识别危险 Shell 结构；
- 校验路径、扩展名、补丁和 URL；
- 检查搜索查询是否把“知名”擅自强化为“最知名”；
- 判断抓取 URL 是否来自本轮搜索；
- 从工具结果提取版本、日期、文件和行号；
- 为 Memory 检索扩展“错误、保存、运行”等召回词；
- 读取旧 Session 的历史结果标签。

不允许重新出现的规则包括：

- “出现某个中文短语就进入 Direct 模式”；
- “出现 search 就只能联网，之后不能写文件”；
- “出现文件审查就开放/关闭一组固定工具”；
- “短追问命中特殊句式就绕过模型直接回复”；
- “用原始问句正则决定最新版任务的证据门槛”。

最新版/当前版本所需的搜索视角、时效、权威来源和抓取门槛已经进入 `TaskFrame.webEvidencePolicy`，Guardrail 只执行结构化策略。

## 6. Context 与 Conversation

TaskFrame 先使用固定预算的最近 Conversation。需要更早证据时，模型通过 `conversationEvidence` 提供语义查询；`TaskFrameConversationSelector` 从完整 Session 选择匹配消息及相邻上下文。

ContextBuilder 不因问句关键词自动预加载仓库树、README、Git diff 或构建文件。模型需要仓库证据时调用安全读取工具。

系统区分：

- Conversation：用户与助手可见消息；
- AgentState：当前运行的 Decision、Tool、Patch、Command 和错误；
- Context：本轮选择给模型的有界证据；
- Session Memory：当前 Session 的结构记录；
- Long-term Memory：策略允许写入的稳定偏好、决策和已验证结果；
- Prompt Cache / Embedding Cache：服务商或本地的计算复用。

## 7. Web 研究与继续写代码

Web 是可组合能力，不是执行器。

```text
TaskFrame(target=MIXED, webEvidence=true, repositoryWrite=REQUIRED)
  -> web_search
  -> fetch_url
  -> read_file（可选）
  -> APPLY_PATCH
  -> RUN_COMMAND（需要时）
  -> FINAL
```

`webEvidencePolicy` 决定：

- 最少非等价搜索视角；
- 最少抓取来源；
- 最少独立域名；
- 是否必须引用 URL；
- 是否要求当前时效证据；
- 是否必须检查权威来源。

`WebResearchProgress` 把当前证据阶段返回 Context，Agent 可以看到下一步应搜索、抓取、比较还是综合。接近步数上限时预留最终综合步骤，避免无限工具循环。

## 8. 仓库工具与 `read_file`

安全读取工具在 TaskFrame 完成后可发现，并在模型选择后获得最小授权：

- `list_files`
- `read_file`
- `search_code`
- `git_status`
- `git_diff`

`read_file`：

- 接受仓库相对路径和位于仓库内的绝对路径；
- 拒绝仓库外路径、内部 `.git/.mini-agent`、目录和二进制文件；
- 自动限制最大行数与 Token；
- 返回 `hasMore`、`nextStartLine`、`nextStartColumn`；
- 为完整审查记录来源哈希和分页覆盖。

“输入无效”只应用于真正不符合 Schema 的字段；过大的安全分页建议会被调整并在 metadata 中说明。

## 9. 完成性与验证

模型返回 `FINAL success=true` 不代表运行立即成功。Guardrail 会检查：

- Required 写入是否真实发生；
- 条件写入是否有调查依据；
- 目标文件是否读取；
- 完整审查是否覆盖到 EOF；
- Web 搜索、抓取、时效、权威和引用是否满足 TaskFrame；
- 知识库回答是否执行 `knowledge_search`；
- 源码/配置修改是否在最新补丁之后通过相关验证；
- 明确要求的 writer/reviewer 是否完成；
- 答案形态和深度是否满足 TaskFrame。

## 10. 多 Agent

多 Agent 仍在父 AgentLoop 中编排：

- `READ_ONLY` 子任务调查仓库；
- `PROPOSE_CHANGES` writer 在临时 worktree 修改和验证；
- `REVIEW_CHANGES` reviewer 读取物化后的依赖补丁；
- 只有父 Agent 能执行 `APPLY_DELEGATED_PATCH`；
- 父工作区改变时重新校验基线与补丁；
- 冲突返回 `DELEGATED_PATCH_CONFLICT`；
- 用户明确要求子 Agent 时，预算耗尽返回 `REQUIRED_DELEGATION_EXHAUSTED`，主 Agent 不能偷偷代写。

## 11. 历史数据兼容

源码仍能读取旧 Session / Change Log 中的 `DIRECT_ANSWER`、`WEB_ANSWER`、`CODE_REVIEW` 等结果字符串，也能迁移旧配置文件位置。这些是持久化数据兼容，不是当前执行模式。

当前配置没有 `controlPlane` 选项。旧配置里即使存在 `"controlPlane": "legacy"`，加载后也会删除该字段。

## 12. 对应源码

- `src/runtime/TaskFrame.ts`
- `src/runtime/TaskFrameResolver.ts`
- `src/runtime/TaskFrameContract.ts`
- `src/agent/AgentLoop.ts`
- `src/agent/CapabilityNegotiator.ts`
- `src/agent/TaskGuardrails.ts`
- `src/agent/WebResearchProgress.ts`
- `src/context/ContextBuilder.ts`
- `src/tools/ReadFileTool.ts`
- `src/cli/AgentLoopTask.ts`

当前只有这一套运行时目录与任务契约编译器，不存在版本化的并行控制面。
