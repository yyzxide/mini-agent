# 演示脚本

这份脚本按“最稳演示优先”的顺序组织。建议先演示 CLI 和 Web 本地模式，再根据现场环境决定是否演示 Docker。

## 1. 演示前检查

在仓库根目录执行：

```bash
pnpm install
pnpm verify
```

如果只想快速验证 Runner：

```bash
pnpm verify:runner
```

如果要演示后端：

```bash
pnpm verify:backend
```

如果要演示前端：

```bash
pnpm verify:frontend
```

## 2. CLI 演示

### 2.1 准备一个临时 Git 仓库

不要直接在项目仓库里演示代码修改，建议用 `/tmp` 下的临时仓库：

```bash
rm -rf /tmp/mini-agent-demo
mkdir -p /tmp/mini-agent-demo
cd /tmp/mini-agent-demo
git init
printf "initial line\n" > demo.txt
git add demo.txt
git commit -m "chore: init demo"
```

如果本机没有配置 Git 用户，可以临时设置：

```bash
git config user.name "Demo User"
git config user.email "demo@example.com"
```

### 2.2 执行 Mock Agent 任务

假设项目路径是 `/home/sid/miniagent/mini-coding-agent`：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes
```

重点观察输出：

- `[plan]`
- `[tool] search_code`
- `[tool] read_file`
- `[patch]`
- `[command]`
- `[diff]`
- `[summary]`

### 2.3 查看结果

```bash
git diff
ls -R .mini-agent
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js sessions
```

可以补充展示工具调试命令：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js tool list
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js tool run read_file '{"path":"demo.txt"}'
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js git diff
```

讲解点：

- Agent 没有直接写文件，而是通过 patch。
- 命令执行需要权限，`--yes` 是演示时自动审批。
- session/event 都保存在本地，后续可以被后端读取。

## 3. 真实模型演示

如果有 OpenAI-compatible 服务：

```bash
export MINI_AGENT_BASE_URL="https://api.openai.com/v1"
export MINI_AGENT_API_KEY="your-api-key"
export MINI_AGENT_MODEL="your-model"

node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js run "查看当前项目结构并总结修改入口" --real --max-steps 8
```

建议现场先用只读任务，不要一上来让真实模型修改大仓库。

## 4. 后端演示

在项目根目录先构建 Runner：

```bash
pnpm build
```

启动后端：

```bash
cd backend
mvn spring-boot:run
```

打开 Swagger：

```text
http://localhost:8080/swagger-ui/index.html
```

创建 LOCAL 任务：

```http
POST /api/agent/tasks
Content-Type: application/json

{
  "repoPath": "/tmp/mini-agent-demo",
  "userGoal": "demo: 给 demo.txt 增加 hello from backend",
  "maxSteps": 20,
  "autoApprove": true,
  "useRealModel": false,
  "executionMode": "LOCAL"
}
```

然后查看：

```text
GET /api/agent/tasks
GET /api/agent/tasks/{id}
GET /api/agent/tasks/{id}/events
GET /api/agent/tasks/{id}/logs
GET /api/agent/tasks/{id}/diff
GET /api/agent/tasks/{id}/session/records
GET /api/agent/tasks/{id}/session/events
```

讲解点：

- 后端不重写 Agent，只启动 Runner。
- `MINI_AGENT_EVENT` 让 CLI 过程变成后端可消费的事件流。
- H2 保存任务、日志和事件，session JSONL 仍保存在工作仓库。

## 5. 前端演示

后端启动后，新开终端：

```bash
cd frontend
pnpm install
pnpm dev
```

打开：

```text
http://localhost:5173
```

演示路径：

1. 进入创建任务页。
2. repoPath 填 `/tmp/mini-agent-demo`。
3. userGoal 填 `demo: 给 demo.txt 增加 hello from web console`。
4. execution mode 选 `LOCAL`。
5. autoApprove 打开。
6. 提交任务。
7. 在任务详情页观察事件、日志、diff、session。

讲解点：

- 前端展示的是后端控制面，不直接访问本地文件。
- SSE 断开会回退轮询。
- 详情页同时展示过程数据和最终交付数据。

## 6. Docker 沙箱演示

先构建镜像：

```bash
cd /home/sid/miniagent/mini-coding-agent
pnpm run docker:build-sandbox
```

确认 Docker 可用：

```bash
docker images | grep mini-coding-agent-sandbox
```

创建 DOCKER 任务：

```http
POST /api/agent/tasks
Content-Type: application/json

{
  "repoPath": "/tmp/mini-agent-demo",
  "userGoal": "demo: 给 demo.txt 增加 hello from docker sandbox",
  "maxSteps": 20,
  "autoApprove": true,
  "useRealModel": false,
  "executionMode": "DOCKER"
}
```

查看沙箱信息：

```text
GET /api/agent/tasks/{id}/sandbox
```

讲解点：

- Docker 模式复制仓库到 `backend/data/workspaces/task_<id>/repo`。
- Agent 修改的是 workspace 副本，不是原始仓库。
- 容器默认无网络，runner 只读挂载。

如果 Docker 镜像拉取慢或环境不可用，可以直接说明：Docker 部分已有命令构造、workspace 复制和服务测试，现场演示切回 LOCAL。

## 7. Git Workflow 演示

当任务状态为 `COMPLETED` 且 diff 非空时，可以在前端任务详情页的 Diff/Git Workflow 区域操作：

1. Create branch
2. Commit
3. Generate PR draft
4. Complete workflow

也可以通过接口调用：

```text
POST /api/agent/tasks/{id}/git/branch
POST /api/agent/tasks/{id}/git/commit
POST /api/agent/tasks/{id}/git/pr-draft
POST /api/agent/tasks/{id}/git/complete
GET  /api/agent/tasks/{id}/git
```

讲解点：

- `LOCAL` 模式会修改原始仓库分支。
- `DOCKER` 模式会修改 workspace 内的仓库。
- 当前生成本地 commit 和 PR 草稿，不自动推送远端。

## 8. 演示时常见问题

### pnpm 命令不可用

使用 corepack：

```bash
corepack enable
corepack pnpm install
```

### 后端报 repoPath outside workspace-root

调整 `backend/src/main/resources/application.yml` 的 `code-agent.workspace-root`，或选择 workspace-root 下的仓库。

### 前端无法连接后端

确认后端在 `8080`：

```text
http://localhost:8080/swagger-ui/index.html
```

或设置：

```bash
VITE_API_BASE_URL=http://localhost:8080 pnpm dev
```

### Docker 任务失败

优先检查：

```bash
docker ps -a
docker images
```

然后在前端查看 stderr 日志和 sandbox 信息。

### Git Workflow 按钮不可用

确认：

- 任务状态是 `COMPLETED`。
- diff 非空。
- 目标仓库是 Git 仓库。

