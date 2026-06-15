# 架构设计说明

## 1. 项目定位

`mini-coding-agent` 的核心目标不是“调用一次大模型”，而是实现一个可审计、可验证、可扩展的本地 Coding Agent 闭环：

1. 接收自然语言代码任务。
2. 扫描当前仓库并构建上下文。
3. 通过受控工具搜索代码、读取文件、查看 Git 状态。
4. 生成 patch，并在应用前做路径校验和 `git apply --check`。
5. 执行测试或验证命令，并把失败输出反馈给下一轮。
6. 输出总结、测试结果和最终 diff。
7. 把对话、工具调用、命令执行和文件变更写入本地 JSONL session。

当前实现已经从单一 CLI 扩展成三层形态：

- TypeScript Runner：核心 Agent Loop、工具系统、权限、patch、命令执行、session。
- Java Backend：任务控制面、日志事件落库、SSE、Docker 沙箱、Git Workflow。
- React Frontend：任务创建、任务详情、事件时间线、日志、diff、session、Git Workflow 操作。

## 2. 总体分层

```text
User
  |
  | CLI / Web
  v
React Frontend -----> Java Spring Boot Backend -----> TypeScript Runner
                            |                              |
                            |                              +-- ToolRegistry
                            |                              +-- PermissionManager
                            |                              +-- PatchManager
                            |                              +-- CommandRunner
                            |                              +-- SessionStore / EventStore
                            |
                            +-- H2 task/log/event storage
                            +-- Docker sandbox orchestration
                            +-- Git Workflow branch/commit/PR draft
```

这个拆分的好处是：

- CLI 可以独立运行，适合本地快速使用。
- Backend 不重写 Agent，只负责任务生命周期和可视化 API。
- Frontend 不接触本地文件系统，只通过后端接口查看状态。
- Docker 模式可以把任务工作区和原始仓库隔离开。

## 3. TypeScript Runner

Runner 位于 `src/`，是项目最核心的一层。

### 3.1 CLI

入口是 `src/cli/index.ts`，支持：

- `mini-agent`：交互式任务。
- `mini-agent run "task"`：一次性执行任务。
- `mini-agent tool run ...`：调试工具调用。
- `mini-agent command run ...`：调试命令执行。
- `mini-agent patch ...`：预览或应用 patch。
- `mini-agent session ...`：查看 session 和 event。
- `mini-agent git ...`：本地 Git 辅助命令。

CLI 的价值是提供最短路径的可运行体验。即使没有后端和前端，核心闭环仍然可以验证。

### 3.2 Agent Loop

`AgentLoop` 负责把 LLM 决策转换成实际动作：

1. 初始化 `AgentState`。
2. 用 `ContextBuilder` 构建上下文。
3. 调用 `LlmClient.chat()` 获取 `AgentDecision`。
4. 根据 decision 类型执行工具、应用 patch、执行命令、询问用户或结束任务。
5. 把每一步写入 session/event。
6. 命令失败时把错误日志放回上下文，继续下一轮。
7. 达到最大步数或 final 时结束。

Decision 类型包括：

- `tool_call`
- `apply_patch`
- `run_command`
- `ask_user`
- `final`

这个设计让真实模型输出也必须进入同一套受控执行语义，避免把模型供应商逻辑散落到业务代码里。

### 3.3 工具系统

工具统一实现 `Tool<TInput, TResult>`：

```ts
interface Tool<TInput, TResult> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  permissionLevel: PermissionLevel;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TResult>>;
}
```

关键点：

- 所有输入经过 zod 校验。
- 所有输出都是结构化 `ToolResult`。
- 工具异常由 `ToolRegistry` 包装，不直接炸掉主流程。
- 工具调用带 `ToolContext`，至少包含 `repoPath` 和可选 `sessionId`。
- 权限等级分为 `SAFE`、`REVIEW`、`DANGEROUS`。

当前工具：

- `list_files`
- `read_file`
- `search_code`
- `git_status`
- `git_diff`
- `apply_patch`

命令执行单独通过 `CommandRunner`，也可以从 CLI 调试。

### 3.4 路径安全

文件工具通过 `resolveRepoPath(repoPath, targetPath)` 做路径归一化和边界检查：

- 支持相对路径。
- 解析绝对路径后必须仍在 repoPath 内。
- 拒绝 `../` 逃逸。
- 拒绝读取二进制文件。
- patch 应用前检查 diff 中的目标路径。

这是本地 Agent 的底线能力：模型不能直接用一个路径字符串突破仓库边界。

### 3.5 权限与命令

`PermissionManager` 把操作分成：

- `SAFE`：只读，默认允许。
- `REVIEW`：会修改文件，经过权限层、路径校验和 patch check。
- `DANGEROUS`：会执行命令，经过权限层、超时控制和基础风险拦截。

命令执行由 `CommandRunner` 完成：

- 工作目录可控。
- 默认超时。
- 捕获 stdout/stderr/exitCode。
- 输出截断。
- 失败返回结构化结果。

第一版危险命令拦截使用字符串规则，覆盖 `rm -rf /`、`sudo`、`mkfs`、`shutdown`、`reboot`、`chmod 777 /` 等高风险动作。

### 3.6 Patch

`PatchManager` 基于 `git apply`：

1. 预览 patch，统计文件、增删行。
2. `git apply --check`。
3. `git apply`。
4. 获取最终 `git diff`。
5. 写入 session/event。

这比直接写文件更容易审计，也更符合代码评审习惯。

### 3.7 Session 和 Event

Runner 在仓库根目录创建：

```text
.mini-agent/
  config.json
  index.json
  sessions/<sessionId>.jsonl
  events/<sessionId>.jsonl
```

Session 记录面向恢复和审计，Event 记录面向时间线和后端消费。后端通过 `MINI_AGENT_EVENT {...}` 解析 Runner 输出，把事件同步进数据库。

### 3.8 模型配置

Runner 支持从仓库根目录的 `mini-agent.config.json` 读取默认模型配置：

```json
{
  "version": 1,
  "llm": {
    "mode": "real",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your_api_key",
    "model": "your_model"
  }
}
```

配置优先级：

1. CLI 参数，例如 `--model`、`--base-url`。
2. 当前仓库 `mini-agent.config.json`。
3. 环境变量，例如 `MINI_AGENT_API_KEY`、`MINI_AGENT_MODEL`。

`mini-agent.config.json` 已被 git 忽略，避免 API key 被提交。需要更安全时，可以配置 `apiKeyEnv`，只把环境变量名写入配置文件。旧版本 `.mini-agent/config.json` 仍作为兼容路径读取，但不再推荐手写到那里。

## 4. Java Backend

后端位于 `backend/`，职责是控制面，不重写 Agent。

### 4.1 任务生命周期

核心状态：

- `CREATED`
- `STARTING`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

后端接收任务后，会根据执行模式启动 Runner：

- `LOCAL`：在用户指定仓库直接运行。
- `DOCKER`：复制仓库到任务工作区，在容器内运行。

后端保存：

- 任务元数据。
- stdout/stderr 日志。
- Runner event。
- Docker sandbox 信息。
- Git Workflow 状态。

### 4.2 路径边界

`PathSecurityService` 确保提交的 `repoPath` 必须在配置的 `workspace-root` 之内。这是后端层面的第一道边界，避免 Web API 被用于访问任意本地路径。

### 4.3 Runner 启动

`RunnerCommandBuilder` 使用参数列表构造命令，而不是拼 shell 字符串。典型命令：

```bash
node ../dist/cli/index.js run "给 demo.txt 增加 hello" --max-steps 20 --event-stream
```

`--event-stream` 让 Runner 输出结构化事件行：

```text
MINI_AGENT_EVENT {"type":"TOOL_CALL_STARTED", ...}
```

后端只解析带这个前缀的行，普通日志仍然作为 stdout/stderr 保存。

### 4.4 Docker 沙箱

Docker 模式的工作流：

1. 为任务创建 `data/workspaces/task_<id>/repo`。
2. 复制用户仓库，保留 `.git`，跳过构建产物和本地缓存。
3. 用 `docker run` 启动 Runner。
4. 将任务 repo 挂载为可写 `/workspace`。
5. 将 runner 源码挂载为只读 `/opt/mini-agent`。
6. 默认关闭网络，限制 CPU 和内存。
7. 任务结束后保留 workspace 供查看 diff/session。

这个设计不会把宿主机 Docker socket 暴露给容器，也不会把原始仓库直接作为容器写入目录。

### 4.5 Git Workflow

Git Workflow 是“任务完成后交付”的一层：

1. 创建任务分支。
2. 提交当前 diff。
3. 生成 PR title 和 description 草稿。
4. 标记流程完成。

在 `LOCAL` 模式下操作原始仓库，在 `DOCKER` 模式下操作任务 workspace 内的仓库。Web 页面会提示不同模式的风险。

## 5. React Frontend

前端位于 `frontend/`，提供可视化控制台：

- `/tasks`：任务列表、状态筛选、仓库筛选、取消任务。
- `/tasks/create`：创建任务，选择执行模式、模型模式、最大步数、自动审批。
- `/tasks/:id`：任务详情，查看元数据、事件、日志、diff、session、Git Workflow。

关键设计：

- API 访问集中在 `src/api/`。
- 事件展示抽象成 `EventTimeline`。
- 日志展示抽象成 `LogViewer`。
- diff 展示抽象成 `DiffViewer`。
- `useTaskEvents` 优先使用 SSE，断线后回退轮询。

前端不直接执行本地命令，所有本地能力都通过后端 API 间接访问。

## 6. 数据流

### 6.1 CLI 本地任务

```text
User -> mini-agent run -> AgentLoop -> Tool/Command/Patch -> .mini-agent JSONL -> final diff
```

适合快速验证核心闭环。

### 6.2 后端 LOCAL 任务

```text
Frontend -> Backend -> node dist/cli/index.js -> original repo -> .mini-agent -> Backend DB -> Frontend
```

适合本地演示，但会直接修改原始仓库。

### 6.3 后端 DOCKER 任务

```text
Frontend -> Backend -> copy repo -> docker run -> workspace repo -> .mini-agent -> Backend DB -> Frontend
```

适合更安全的任务执行和演示。

### 6.4 Git Workflow

```text
Completed task -> GitWorkflowService -> branch -> commit -> PR draft -> Frontend
```

当前只生成本地分支和 PR 草稿，不直接推送远端。

## 7. 安全边界

已经实现的边界：

- Runner 文件路径不能逃逸 repoPath。
- 后端 repoPath 必须在 workspace-root 内。
- patch 应用前做 `git apply --check`。
- 命令执行有超时、输出限制和危险命令拦截。
- Docker 默认联网以访问模型端点，可配置关闭网络，并限制 CPU/内存。
- Docker 中 runner 只读挂载。
- 真实模型 API key 不写入任务日志或数据库命令字段。

仍需加强的方向：

- 更强的 shell 语义解析，而不是字符串拦截。
- patch 内容的更细粒度策略，例如限制文件类型和最大修改量。
- Docker seccomp/AppArmor/profile。
- 多用户权限和任务隔离。
- Secret redaction 覆盖更多输出通道。

## 8. 为什么这样拆分

### 为什么 Runner 用 TypeScript

Coding Agent 的工具调用、schema 校验、CLI 交互和前端生态更贴近 Node.js。TypeScript 也方便和 zod、commander、execa 等工具组合。

### 为什么后端用 Java

Java/Spring Boot 更适合做长期运行的控制面：任务状态、数据库、REST API、SSE、Docker 编排、企业级后端风格的可维护性。

### 为什么 session 用 JSONL

JSONL 简单、可追加、便于人工查看，也方便后端按行读取。对本地 Agent 来说，它比一开始引入复杂数据库更轻。

### 为什么 patch 优先于直接写文件

patch 是天然的变更边界，适合预览、审计、回滚和评审，也便于把最终 diff 交给 Git Workflow。

## 9. 扩展点

- `LlmClient`：接入更多 OpenAI-compatible 或本地模型。
- `ToolRegistry`：新增语义搜索、AST 分析、测试定位工具。
- `PermissionManager`：加入项目策略、用户配置和命令 allowlist。
- `ContextBuilder`：加入 token budget、摘要缓存、文件重要性排序。
- `DockerSandboxService`：加入镜像 profile、资源配额和产物导出。
- `GitWorkflowService`：接入 GitHub/GitLab API 创建真实 PR。
