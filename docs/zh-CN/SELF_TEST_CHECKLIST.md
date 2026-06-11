# 自测清单

这份清单用于提交前、演示前或面试前快速确认项目状态。

## 1. 基础环境

- Node.js 版本 >= 20。
- pnpm 可用。
- Java 版本 >= 17。
- Maven 可用。
- `rg` 可用，用于代码搜索工具。
- Git 可用，当前项目已经 `git init`。
- 如需 Docker 演示，Docker daemon 正常运行。

检查命令：

```bash
node --version
pnpm --version
java -version
mvn --version
rg --version
git --version
docker --version
```

## 2. 全量验证

从仓库根目录执行：

```bash
pnpm install
pnpm verify
```

如果没有全局 `pnpm`：

```bash
corepack pnpm install
corepack pnpm verify
```

预期：

- TypeScript Runner build 通过。
- TypeScript Runner test 通过。
- Java Backend `mvn test` 通过。
- React Frontend build 通过。

如果只验证某一层：

```bash
pnpm verify:runner
pnpm verify:backend
pnpm verify:frontend
```

`verify:backend` 会把 Maven 本地仓库放在 `backend/.m2`，避免在受限环境里写入用户主目录。

## 3. CLI 验证

构建 Runner：

```bash
pnpm build
```

查看帮助：

```bash
node dist/cli/index.js --help
```

预期能看到：

- `run`
- `config`
- `resume`
- `sessions`
- `diff`
- `tool`
- `command`
- `patch`
- `session`
- `git`

## 4. 工具系统验证

```bash
node dist/cli/index.js tool list
node dist/cli/index.js tool run list_files '{"path":"."}'
node dist/cli/index.js tool run read_file '{"path":"README.md"}'
node dist/cli/index.js tool run search_code '{"query":"AgentLoop","path":"src"}'
node dist/cli/index.js tool run git_status '{}'
node dist/cli/index.js tool run git_diff '{}'
```

预期：

- 输出是 JSON。
- `list_files` 能列出项目文件。
- `read_file` 能返回内容和行号。
- `search_code` 能返回匹配路径、行号和文本。
- `git_status` 和 `git_diff` 在 Git 仓库中正常返回。

## 4.5 真实模型配置验证

```bash
node dist/cli/index.js config init \
  --real \
  --base-url "https://api.openai.com/v1" \
  --api-key "your_api_key" \
  --model "your_model"

node dist/cli/index.js config show
```

预期：

- `.mini-agent/config.json` 被创建或更新。
- `config show` 中 `apiKey` 显示为 `<redacted>`。
- 后续 `run` 不带 `--real` 也会默认使用真实模型。

临时切回 Mock：

```bash
node dist/cli/index.js run "demo task" --mock
```

## 5. Mock Agent 闭环验证

建议在临时仓库里验证，避免污染项目仓库：

```bash
rm -rf /tmp/mini-agent-smoke
mkdir -p /tmp/mini-agent-smoke
cd /tmp/mini-agent-smoke
git init
git config user.name "Smoke Test"
git config user.email "smoke@example.com"
printf "initial line\n" > demo.txt
git add demo.txt
git commit -m "chore: init"
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes
git diff
```

预期：

- 输出包含 plan、tool、patch、command、diff、summary。
- `demo.txt` 出现新增内容。
- `.mini-agent/sessions` 和 `.mini-agent/events` 下生成 JSONL 文件。

## 6. 命令执行验证

在任意 Git 仓库中：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js command run "echo hello" --yes
```

预期：

- `success: true`
- `exitCode: 0`
- stdout 包含 `hello`

危险命令验证：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js command run "sudo ls" --yes
```

预期：

- 命令被拒绝。
- 输出结构化错误。

## 7. Patch 验证

在临时仓库中创建 patch：

```bash
cat > /tmp/demo.patch <<'EOF'
diff --git a/demo.txt b/demo.txt
index 8d2d95f..c0d0fb4 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1 +1,2 @@
 initial line
+patched line
EOF
```

预览：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js patch preview /tmp/demo.patch
```

应用：

```bash
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js patch apply /tmp/demo.patch --yes
```

预期：

- preview 能显示文件和增删行。
- apply 前执行 `git apply --check`。
- apply 后 `git diff` 能看到新增行。

## 8. 后端验证

在根目录构建 Runner：

```bash
pnpm build
```

启动后端：

```bash
cd backend
mvn spring-boot:run
```

打开：

```text
http://localhost:8080/swagger-ui/index.html
```

创建任务后检查：

- `GET /api/agent/tasks`
- `GET /api/agent/tasks/{id}`
- `GET /api/agent/tasks/{id}/events`
- `GET /api/agent/tasks/{id}/logs`
- `GET /api/agent/tasks/{id}/diff`
- `GET /api/agent/tasks/{id}/session/records`
- `GET /api/agent/tasks/{id}/session/events`

## 9. 前端验证

后端启动后：

```bash
cd frontend
pnpm install
pnpm dev
```

打开：

```text
http://localhost:5173
```

检查：

- 任务列表可加载。
- 可创建任务。
- 任务详情页能看到事件、日志和 diff。
- session drawer 可打开。
- Git Workflow 面板在任务完成且 diff 非空时可操作。

## 10. Docker 沙箱验证

构建镜像：

```bash
pnpm run docker:build-sandbox
```

创建任务时选择：

```json
{
  "executionMode": "DOCKER"
}
```

检查：

- 后端有 sandbox 记录。
- `backend/data/workspaces/task_<id>/repo` 存在。
- 原始仓库没有被 Docker 任务直接修改。
- 容器启动命令包含 CPU、memory 和 network 限制。

## 11. 提交前检查

```bash
git status --short
git diff --stat
pnpm verify
```

建议提交信息格式：

```text
feat: ...
fix: ...
docs: ...
test: ...
chore: ...
```

## 12. 面试前检查

- 能用 30 秒讲清项目目标。
- 能画出 Runner、Backend、Frontend 三层结构。
- 能解释为什么要 ToolRegistry。
- 能解释 session/event 的作用。
- 能说明 Docker 沙箱边界和不足。
- 能现场跑 CLI mock demo。
- 能承认当前真实模型质量和生产安全还有提升空间。
