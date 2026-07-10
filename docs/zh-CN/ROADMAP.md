# Roadmap

当前路线：先把本地 CLI Coding Agent 的工程骨架打磨扎实，再考虑真实 MCP server、生产级向量检索、TUI/编辑器集成和外部平台化。

## 0. 已完成的核心能力

当前已经具备：

- 交互式 CLI 和一次性 `run`。
- direct / web / review / agent-loop 四种任务模式。
- 真实 OpenAI-compatible API 接入。
- 结构化 `AgentDecision`。
- `ToolRegistry`、zod 输入校验和结构化 `ToolResult`。
- 本地工具：读文件、列文件、代码搜索、git status/diff、web_search、fetch_url、apply_patch。
- 工具能力标注：只读、破坏性、幂等性、是否访问外部世界。
- MCP 风格本地 tool descriptor 导出：`mini-agent mcp tools`。
- patch check/apply 和命令执行保护。
- patch 应用固定 `core.autocrlf=false`，降低跨机器换行配置影响。
- `read_file` / `search_code` 对 `.git`、`.mini-agent` 等内部元数据路径做拒绝保护。
- JSONL session/event/log/change-log。
- 本地长期记忆索引和轻量 RAG：query build、retrieve、rerank、evidence select、context injection。
- Agent Harness：脚本化 LLM + 临时仓库 + AgentLoop 场景评测。
- 当前全量回归通过 32 个测试文件、230 个测试用例。

## 1. P0：继续提高稳定性

### 1.1 拆分 CLI 主文件

`src/cli/index.ts` 仍然过大，当前已经超过 4200 行，承担了命令注册、交互循环、direct/web/review/agent 四条执行链、日志和渲染逻辑。

建议拆成：

- `src/cli/program.ts`：Commander 命令注册。
- `src/cli/interactive.ts`：交互式 session 和 slash commands。
- `src/cli/taskRunner.ts`：run/review/direct/web/agent 模式调度。
- `src/cli/render.ts`：终端输出格式。
- `src/cli/commands/*`：config、tool、mcp、memory、session、git 等子命令。

### 1.2 增强决策质量闸门

当前已有 `DecisionParser` 和 `TaskGuardrails`，下一步重点：

- 对工具调用参数做更细的语义校验。
- 对 `FINAL success` 加更多后置条件。
- 对连续无效 patch / 同一错误循环做更明确的 recovery prompt。
- 把 guardrail violation 变成可统计指标。

### 1.3 扩展 Agent Harness 场景集

当前 Harness 已能跑 scripted AgentLoop 场景。下一步：

- 增加 JSON/YAML 场景文件。
- 覆盖常见真实问题：写文件、修复失败测试、错误诊断、代码审查、联网答复纠偏、短追问落盘。
- 输出场景报告：成功率、步数、失败原因、关键记录。
- 增加少量真实 API 抽样评测，但不能让 CI 依赖真实 API。

## 2. P1：RAG 和 MCP 深化

### 2.1 长期记忆升级

当前是本地 JSONL + 本地确定性向量，适合 MVP。后续可以：

- 抽象 `EmbeddingProvider`。
- 接真实 embedding API。
- 将 `MemoryRetriever` 的存储层替换为 SQLite FTS、LanceDB、Qdrant 或 pgvector。
- 增加 memory aging、冲突检测、置信度和手动遗忘。
- 对检索结果做 LLM rerank 或 cross-encoder rerank。

### 2.2 真实 MCP runtime

当前已经有 MCP 风格 tool descriptor 和 MCP server config schema，但还没有真正连接第三方 MCP server。

真正接入需要：

- MCP stdio/SSE client。
- server lifecycle 管理。
- tools/list 与 tools/call。
- MCP tool 到本地 `Tool` 的权限映射。
- 外部工具调用的 session/event/log 记录。
- 对 MCP server 的超时、输出截断、失败隔离和安全配置。

这一步要谨慎做，不能为了“有 MCP”而放开任意外部命令。

### 2.3 Tool Calling 质量

- 为每个工具补更细的 examples。
- 将 tool manifest 注入 prompt，而不是只注入 schema。
- 引入 tool choice 评测：给定任务应选择哪些工具。
- 对工具结果做 evidence summary，减少上下文噪声。

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

### 3.3 更好的终端输出

- 分组展示 plan、tool、patch、command、result。
- 对长输出折叠。
- 对 diff 做文件级摘要。
- 对错误给出下一步建议。

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
