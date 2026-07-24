# Roadmap

当前路线：单一 AgentLoop、MCP tools runtime、终端事件时间线、任务级 Diff Viewer 和分层上下文压缩已落地，下一阶段扩展真实 Eval、分级记忆、MCP 高级能力与持续式 TUI。已经完成的设计迁移不在这里展开，见 [架构演进记录](ARCHITECTURE_EVOLUTION.md)。

## 0. 已完成的核心能力

当前已经具备：

- 交互式 CLI 和一次性 `run`。
- 单一 `AgentLoop` + `AgentTaskContract`，统一执行 Direct、Web、Review、Repository Analysis 和 Repository Task。
- `TaskUnderstanding` 统一解释操作、目标、回答形态、证据等级和仓库意图；默认契约 deny-by-default。
- 真实 OpenAI-compatible API 接入。
- 结构化 `AgentDecision`。
- `ToolRegistry`、zod 输入校验和结构化 `ToolResult`。
- 本地工具：读文件、列文件、代码搜索、git status/diff、web_search、fetch_url、apply_patch。
- 工具能力标注：只读、破坏性、幂等性、是否访问外部世界。
- MCP stdio/Streamable HTTP 工具发现、权限映射与调用：`mini-agent mcp tools/status/call`。
- patch check/apply 和命令执行保护。
- patch 应用固定 `core.autocrlf=false`，降低跨机器换行配置影响。
- `read_file` / `search_code` 对 `.git`、`.mini-agent` 等内部元数据路径做拒绝保护。
- JSONL session/event/log/change-log。
- 本地长期记忆索引：query build、retrieve、rerank、evidence select、context injection。
- 独立文档知识库 RAG：Markdown/TXT 分块、增量索引、混合检索、引用、拒答和离线评测。
- 全模式长期记忆召回、显式 remember/forget、失败过滤、密钥脱敏和 `structured-salience-v2` 分层 compaction。
- 版本化运行事件、实时命令输出、Token/缓存/压缩遥测，以及按需打开的任务级终端 Diff Viewer。
- 声明式 Skill 发现、校验、自动/显式选择以及全模式上下文注入。
- Session 持久化的只读 Plan 模式和 `/plan` -> `/execute` 闭环，带运行时写操作硬拦截。
- 默认可用的语义多 Agent 协作：并行只读调查、临时 worktree 实现与受限验证、依赖式变更审查、基线冲突检测和主 Agent 显式合入。
- Agent Harness：脚本化 LLM + 临时仓库 + AgentLoop 场景评测。
- 当前测试基线以 [中文 README](README.md#核心回归测试) 的最近一次全量验证结果为准。

## 1. P0：继续提高稳定性

### 1.1 继续拆分 CLI 交互与命令注册

持续拆分后，Direct/Web/Review/RepositoryAnalysis 的独立执行器已被删除，统一由 `AgentLoopTask` 和 `CliTaskRuntime` 承担任务执行。Tool/MCP 命令、终端事件 Renderer 和 Diff Viewer 已独立；`src/cli/index.ts` 当前约 2450 行，主要仍承担命令注册、交互循环和 slash command 状态协调。

后续继续拆成：

- `src/cli/program.ts`：Commander 命令注册。
- `src/cli/interactive.ts`：交互式 session 和 slash commands。
- `src/cli/taskRunner.ts`：统一契约构建和 AgentLoop 调用入口。
- `src/cli/sessionCommands.ts`：session、history、compact、resume 等交互操作。
- `src/cli/commands/*`：config、tool、mcp、memory、session、git 等子命令。

### 1.2 增强决策质量闸门

当前已有 `DecisionParser` 和 `TaskGuardrails`，下一步重点：

- 对工具调用参数做更细的语义校验。
- 扩展已落地的 `AnswerQualityPolicy`，用释义/对抗离线 Eval 校准定义、数量、枚举、有界关系和解释型回答的漏拦与误拦。
- 为 `TaskUnderstanding` 增加按语义维度生成的误路由、权限过宽和短追问谓词丢失指标，避免回到主题白名单。
- 将 Web 页面可用性从 WAF/CAPTCHA/登录壳扩展到软 404、无正文 SPA、地区限制和订阅墙。
- 对连续无效 patch / 同一错误循环做更明确的 recovery prompt。
- 把 guardrail violation 变成可统计指标。

### 1.3 扩展 Agent Harness 场景集

当前 Harness 已能跑 scripted AgentLoop 场景，并汇总成功率、步骤、工具选择准确率和失败分类。下一步：

- 增加 JSON/YAML 场景文件。
- 覆盖常见真实问题：写文件、修复失败测试、错误诊断、代码审查、联网答复纠偏、短追问落盘。
- 增加 token、延迟和轨迹回放报告。
- 增加少量真实 API 抽样评测，但不能让 CI 依赖真实 API。

## 2. P1：RAG 和 MCP 深化

### 2.1 长期记忆升级

当前是本地 JSONL + 可替换 embedding provider，适合本地作品和演示。后续可以：

- 为现有真实 embedding provider 增加批量迁移与重建索引命令。
- 将 `MemoryRetriever` 的存储层替换为 SQLite FTS、LanceDB、Qdrant 或 pgvector。
- 将标题级同主题替代升级为语义冲突检测。
- 对检索结果做 LLM rerank 或 cross-encoder rerank。

### 2.2 MCP 高级能力

当前已连接第三方 MCP server 并支持 tools runtime；后续扩展 resources/prompts、server-initiated request、OAuth、缓存和旧 SSE 回退。

已经完成的 tools runtime 包括：

- stdio/Streamable HTTP client 和 server lifecycle。
- tools/list、tools/call 和本地 `Tool` 权限映射。
- 外部工具调用的 session/event/log 记录和超时失败隔离。

下一步补 resources/prompts、server-initiated request、OAuth、通知和旧 SSE 回退。

这一步要谨慎做，不能为了“有 MCP”而放开任意外部命令。

### 2.3 Tool Calling 质量

- 为每个工具补更细的 examples。
- 将 tool manifest 注入 prompt，而不是只注入 schema。
- 引入 tool choice 评测：给定任务应选择哪些工具。
- 对不同工具结果做结构化 evidence normalization；当前 compactor 已能分层和裁剪，但还没有工具语义级摘要。

## 3. P2：开发体验

### 3.1 Dry-run 模式

新增：

```bash
mini-agent run "..." --dry-run
```

只展示计划、工具调用和 patch 预览，不真正落盘或执行危险命令。

### 3.2 Session Replay

支持：

```bash
mini-agent session replay <sessionId>
```

按时间线重放工具调用、命令结果和最终 diff，方便复盘和面试演示。

### 3.3 持续式 TUI

当前已有分组时间线、实时命令输出、长输出截断、Changes 卡片和全屏 Diff Viewer。下一阶段基于同一 `AgentRuntimeEvent` 协议增加：

- 可折叠的长工具结果与错误诊断。
- 固定的任务状态、Token 和 Context 面板。
- Session Replay 与步骤跳转。
- 保持非交互 CLI 和机器事件流兼容。

## 4. 安全增强

- 更细粒度的命令白名单/黑名单。
- patch 修改文件数量和单文件大小限制。
- 工作树脏状态提醒。
- API key redaction 覆盖所有日志和错误。
- 可选只读扫描模式。
- MCP server 权限隔离和显式信任配置。

## 5. 暂不做

当前不在本仓库内做：

- 业务后台。
- Web 控制台。
- 多用户管理。
- 远程 PR 自动创建。
- 生产级沙箱。

这些可以以后作为独立项目或插件实现。本仓库主线仍然是本地 CLI Agent 的核心执行闭环。
