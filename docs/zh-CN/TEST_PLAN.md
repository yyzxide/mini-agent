# 测试计划

## 1. 测试阶段目标

当前项目已经完成 CLI Runner、Java Backend、React Frontend、Docker Sandbox 和 Git Workflow 的 MVP。测试阶段的目标不是一次性追求“覆盖率数字好看”，而是先把关键闭环稳定下来：

1. 核心 Agent Runner 的工具、权限、patch、命令、session 可靠。
2. Java Backend 能稳定启动 Runner、保存日志事件、读取 session、处理 Docker/Git Workflow。
3. React Frontend 能构建通过，并在人工验证中完成任务创建、任务详情、日志、事件、diff 和 Git Workflow 操作。
4. Docker Sandbox 的命令构造、workspace 复制和隔离策略有自动测试与人工验证路径。
5. 每次提交前有明确的自动化验证命令和人工回归清单。

## 2. 测试范围

### 2.1 TypeScript Runner

必须覆盖：

- CLI 命令注册和基础输出。
- ToolRegistry 注册、参数校验、异常包装。
- 文件工具：list_files、read_file、search_code。
- Git 工具：git_status、git_diff。
- PatchManager：preview、check、apply、diff。
- CommandRunner：stdout/stderr/exitCode、timeout、输出截断。
- PermissionManager：SAFE、REVIEW、DANGEROUS、危险命令拦截。
- SessionStore/EventStore：JSONL 写入、读取、索引。
- AgentLoop：Mock LLM 全链路。
- OpenAICompatibleClient：请求构造、响应解析、错误处理。
- DecisionParser：结构化 decision 协议。

### 2.2 Java Backend

必须覆盖：

- Controller API 基础行为。
- AgentTaskService 任务创建、状态流转、取消。
- RunnerCommandBuilder 参数构造。
- RunnerEventParser 事件解析。
- SessionReadService/EventReadService 读取 JSONL。
- PathSecurityService 路径边界。
- WorkspaceService 仓库复制和忽略规则。
- DockerCommandBuilder 参数构造。
- DockerSandboxService 生命周期中的关键分支。
- GitCommandExecutor 分支/提交安全规则。
- GitWorkflowService 状态流转。
- PR draft 和 commit message 生成。

### 2.3 React Frontend

当前自动化主要是 TypeScript/Vite build。测试阶段需要补齐：

- API 层单元测试：成功响应、错误响应、base URL。
- hooks 测试：SSE 成功、SSE 断开后轮询兜底、去重。
- 组件测试：TaskStatusTag、DiffViewer、EventTimeline、LogViewer。
- 页面冒烟：任务列表、任务创建、任务详情。
- GitWorkflowPanel 操作状态：按钮禁用、成功响应、错误提示。

### 2.4 Docker Sandbox

自动化覆盖：

- docker run 参数构造。
- workspace 目录边界。
- repo 复制忽略规则。
- sandbox 状态保存。
- 容器取消命令构造。

人工或集成覆盖：

- 镜像构建。
- 无网络模式。
- workspace 可写、runner 只读。
- 原始仓库不被 DOCKER 模式直接修改。
- stdout/stderr/event 正常回传。

### 2.5 Git Workflow

必须覆盖：

- 分支名校验。
- 空 diff 不允许提交。
- commit message 生成。
- PR draft 生成。
- LOCAL/DOCKER 模式下实际 repo path 选择。
- workflow 状态展示和失败处理。

## 3. 测试分层

### P0：提交前必跑

```bash
corepack pnpm verify
```

等价于：

```bash
corepack pnpm verify:runner
corepack pnpm verify:backend
corepack pnpm verify:frontend
```

P0 通过标准：

- Runner build 通过。
- Runner Vitest 全通过。
- Backend Maven test 全通过。
- Frontend TypeScript/Vite build 通过。

### P1：CLI 冒烟

```bash
node dist/cli/index.js --help
node dist/cli/index.js tool list
node dist/cli/index.js tool run read_file '{"path":"README.md","maxLines":5}'
node dist/cli/index.js git status
```

P1 通过标准：

- 命令退出码为 0。
- 输出 JSON 或帮助文本正常。
- 不产生非预期文件修改。

### P2：Mock Agent 端到端

在临时 Git 仓库中执行：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes
```

P2 通过标准：

- 输出包含 plan/tool/patch/command/diff/summary。
- 文件确实被 patch 修改。
- `.mini-agent/sessions` 和 `.mini-agent/events` 生成 JSONL。
- `git diff` 可查看最终变更。

### P3：Backend + Frontend 手工回归

后端：

```bash
cd backend
mvn spring-boot:run
```

前端：

```bash
cd frontend
corepack pnpm dev
```

P3 通过标准：

- 能创建 LOCAL mock task。
- 任务详情能看到 event、stdout/stderr、diff、session。
- SSE 正常或轮询兜底正常。
- 取消任务不会导致后端异常。

### P4：Docker Sandbox 手工回归

```bash
corepack pnpm run docker:build-sandbox
```

P4 通过标准：

- 镜像构建成功。
- DOCKER 任务成功创建 workspace。
- 容器无网络模式可运行 mock task。
- 原始 repo 不被修改。
- workspace repo 有最终 diff/session。

## 4. 当前自动化覆盖地图

| 模块 | 当前覆盖 | 状态 |
| --- | --- | --- |
| CLI | 命令注册、session、command、patch、mock agent、real client stub | 已覆盖 |
| Tools | list/read/search/git status/git diff/apply patch | 已覆盖 |
| Permission | 权限等级、审批、危险命令 | 已覆盖 |
| Session/Event | JSONL 写入读取、事件记录 | 已覆盖 |
| Patch | preview/check/apply/diff | 已覆盖 |
| Command | 成功、失败、超时、输出 | 已覆盖 |
| LLM | Mock、OpenAI-compatible、decision parser | 已覆盖 |
| Context | ContextBuilder 基础上下文 | 已覆盖 |
| Backend Controller | 任务查询、日志、事件 | 已覆盖 |
| Backend Service | 任务、Runner、Docker、Git Workflow 核心分支 | 已覆盖 |
| Frontend | TypeScript 编译和生产构建 | 部分覆盖 |
| Docker Runtime | 命令构造和 workspace 自动测，真实容器需手工 | 部分覆盖 |
| Real Model E2E | 无真实 API 自动化 | 未覆盖 |
| Remote PR | 当前尚未实现 | 不适用 |

## 5. 测试数据策略

- 单元测试使用临时目录，不依赖用户真实仓库。
- CLI E2E 使用 `/tmp` 下的临时 Git 仓库。
- Backend 测试使用 mock 或临时 workspace。
- Maven 本地仓库使用 `backend/.m2`，避免受限环境写用户主目录。
- Docker 手工测试使用可删除的临时仓库，不使用真实业务仓库。

## 6. 风险用例

### 6.1 路径越权

必须覆盖：

- `../outside.txt`
- 绝对路径 `/etc/passwd`
- symlink 逃逸
- patch 修改 repo 外路径

当前状态：

- 普通相对路径和绝对路径逃逸已有覆盖。
- symlink 逃逸建议补充专项测试。

### 6.2 危险命令

必须覆盖：

- `sudo`
- `rm -rf /`
- `mkfs`
- `shutdown`
- `reboot`
- `chmod 777 /`

当前状态：

- 已有基础危险命令测试。
- 后续应增加 shell 变体，例如多空格、换行、路径参数混淆。

### 6.3 大输出与超时

必须覆盖：

- stdout 超长。
- stderr 超长。
- 命令超时。
- 非 0 exitCode。

当前状态：

- CommandRunner 已覆盖核心分支。

### 6.4 Patch 风险

必须覆盖：

- 非法 patch。
- patch check 失败。
- patch 修改多个文件。
- patch 目标路径逃逸。
- patch 二次应用失败。

当前状态：

- 已覆盖主要成功/失败分支。
- 多文件 patch 和路径逃逸可继续加强。

## 7. 缺口和优先级

### 高优先级

1. 前端单元测试框架：Vitest + React Testing Library。
2. symlink 路径逃逸测试。
3. 多文件 patch 测试。
4. Docker runtime smoke 文档化，并尽量脚本化。

### 中优先级

1. 后端 SSE 流式接口测试。
2. 真实模型 JSON 格式错误 retry 测试。
3. Agent 修复循环测试。
4. Git Workflow LOCAL/DOCKER 更完整集成测试。

### 低优先级

1. 覆盖率统计门禁。
2. 性能基准。
3. 大仓库扫描压测。
4. 跨平台 Windows shell 行为测试。

## 8. 进入标准

进入测试阶段前需要：

- 功能主干已完成。
- 基础文档齐备。
- `pnpm verify` 至少跑通一次。
- CI 已配置。
- 当前未规划大规模重构。

当前项目满足进入标准。

## 9. 退出标准

测试阶段的第一个里程碑可以定义为：

- P0 自动验证稳定通过。
- P1/P2 CLI 冒烟稳定通过。
- 前端至少补齐 API/hook/核心组件测试。
- Docker runtime smoke 有可复现脚本或清单。
- 已知风险记录在测试报告中。
- `main` 分支保持绿色。

## 10. 推荐执行节奏

1. 每次代码修改后跑对应模块测试。
2. 每次提交前跑 `corepack pnpm verify`。
3. 每天结束时生成一份短测试报告。
4. 每个功能阶段结束后跑 P1/P2/P3 手工回归。
5. Docker 相关改动必须跑 P4。

