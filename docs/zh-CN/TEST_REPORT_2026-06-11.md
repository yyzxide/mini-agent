# 测试报告 2026-06-11

## 1. 测试对象

- 项目：`mini-coding-agent`
- 分支：`main`
- Commit：`fa01beb`
- 日期：2026-06-11
- 环境：Ubuntu / Node.js / Java 17 / Maven / corepack pnpm

## 2. 执行结论

本次基线验证通过。项目可以进入正式测试阶段。

## 3. 自动化验证

执行命令：

```bash
COREPACK_HOME=/home/sid/miniagent/mini-coding-agent/.cache/corepack corepack pnpm verify
```

### 3.1 TypeScript Runner

执行内容：

```bash
corepack pnpm build
corepack pnpm test
```

结果：

```text
Test Files  13 passed (13)
Tests       78 passed (78)
```

覆盖重点：

- CLI 命令注册和基础流程。
- ToolRegistry 和只读/patch 工具。
- CommandRunner。
- PermissionManager。
- SessionStore/EventStore。
- PatchManager。
- ContextBuilder。
- AgentLoop scripted model 流程。
- OpenAICompatibleClient stub。
- DecisionParser。

### 3.2 Java Backend

执行内容：

```bash
mvn -Dmaven.repo.local=backend/.m2 -f backend/pom.xml test
```

结果：

```text
Tests run: 29, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

覆盖重点：

- AgentTaskController。
- AgentTaskService。
- RunnerCommandBuilder。
- RunnerEventParser。
- SessionAndEventReadService。
- WorkspaceService。
- DockerCommandBuilder。
- GitCommandExecutor。
- GitWorkflowService。
- GitWorkflowGenerators。

### 3.3 React Frontend

执行内容：

```bash
corepack pnpm --dir frontend install --frozen-lockfile
corepack pnpm --dir frontend build
```

结果：

```text
vite build success
4795 modules transformed
```

提示：

- Vite 输出 chunk size warning：`index-DxoJ6CP4.js` 约 1.24 MB，gzip 后约 401 KB。
- 这是体积优化提示，不影响本次构建通过。

### 3.4 环境提示

安装前端依赖时出现：

```text
ERR_PNPM_META_FETCH_FAIL registry.npmmirror.com
```

影响判断：

- 不影响本次验证结果。
- lockfile 已命中，本地依赖可用，install 和 build 均继续成功。
- 如果在干净 CI 环境出现同类问题，需要检查 registry 或网络配置。

## 4. CLI 冒烟建议

本轮重点跑了 `pnpm verify`。正式测试阶段建议每次 release 前补跑：

```bash
node dist/cli/index.js --help
node dist/cli/index.js tool list
node dist/cli/index.js tool run read_file '{"path":"README.md","maxLines":5}'
node dist/cli/index.js git status
```

并在临时仓库中跑：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js run "查看当前仓库结构并总结可以从哪里开始修改" --max-steps 6
```

## 5. 当前测试覆盖评价

### 已经比较稳的部分

- Runner 核心闭环。
- 工具系统。
- 命令执行和权限。
- patch 应用。
- session/event JSONL。
- Agent scripted-flow E2E。
- 后端任务服务、事件解析、session 读取。
- Docker 命令构造和 workspace 逻辑。
- Git Workflow 生成和执行器基础规则。

### 仍然偏薄的部分

- 前端缺少单元测试和组件测试，目前主要依赖 TypeScript build。
- Docker runtime 真实容器执行还需要手工 smoke。
- SSE 流式接口需要更完整测试。
- 路径安全还可以增加 symlink 逃逸测试。
- patch 可以增加多文件和路径逃逸测试。
- 真实模型 E2E 没有进入自动化，当前只用 stub 验证 client。

## 6. 风险记录

| 风险 | 影响 | 当前状态 | 建议 |
| --- | --- | --- | --- |
| 前端缺少组件测试 | UI 回归可能只能靠人工发现 | 已识别 | 引入 Vitest + React Testing Library |
| Docker runtime 依赖本机环境 | CI 中可能难以稳定跑真实容器 | 已识别 | 先保留手工 P4，再评估 GitHub Actions service |
| registry 网络波动 | 干净环境安装可能失败 | 本次不阻塞 | 固定 registry 或使用缓存 |
| 大 chunk warning | 首屏资源偏大 | 不阻塞 | 后续按路由或重组件 code splitting |
| 真实模型不稳定 | 自动化难复现 | 已隔离 | 使用 scripted LLM 和 fetch stub 做确定性测试 |

## 7. 下一步建议

第一批测试增强建议：

1. 给前端加入 Vitest + React Testing Library。
2. 为 `DiffViewer`、`EventTimeline`、`TaskStatusTag`、`useTaskEvents` 增加测试。
3. 为路径安全补 symlink 逃逸测试。
4. 为 PatchManager/ApplyPatchTool 补多文件 patch 测试。
5. 写一个 Docker smoke 脚本或 Make-like 文档命令。

## 8. 结论

项目当前满足进入测试阶段的条件：

- 主功能闭环已经实现。
- 自动化基线通过。
- CI 已配置。
- 测试缺口已明确。
- 后续可以按 `TEST_PLAN.md` 分层推进。
