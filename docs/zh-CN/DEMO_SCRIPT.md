# 本地演示脚本

这份脚本用于演示纯 CLI 版 `mini-coding-agent`。目标是证明它能在本地仓库中完成“理解任务、调用工具、修改代码、执行命令、输出 diff、保存 session”的闭环。

## 1. 准备项目

```bash
cd /home/sid/miniagent/mini-coding-agent
npm install
npm run build
npm test
npm link
mini-agent --help
```

如果不使用全局链接：

```bash
node dist/cli/index.js --help
```

## 2. 配置模型

```bash
cp mini-agent.config.example.json mini-agent.config.json
```

编辑：

```json
{
  "version": 1,
  "llm": {
    "mode": "real",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your-api-key",
    "model": "your-model",
    "temperature": 0.2,
    "maxTokens": 4096,
    "timeoutMs": 60000
  }
}
```

验证配置脱敏输出：

```bash
mini-agent config show
```

讲解点：

- `mini-agent.config.json` 被 gitignore 忽略。
- `config show` 默认隐藏 apiKey。
- 也可以用环境变量覆盖配置。

## 3. 工具系统演示

```bash
mini-agent tool list
mini-agent tool run list_files '{"path":"src","maxDepth":2}'
mini-agent tool run read_file '{"path":"README.md","maxLines":40}'
mini-agent tool run search_code '{"query":"AgentLoop","path":"src","maxResults":10}'
mini-agent tool run fetch_url '{"url":"https://example.com"}'
mini-agent tool run git_status '{}'
mini-agent tool run git_diff '{}'
```

讲解点：

- 所有工具都有 zod schema。
- 文件路径必须限制在 repoPath 内。
- `search_code` 调用的是 ripgrep。
- `fetch_url` 用于读取公网文档，带超时、大小和内网目标限制。
- 工具结果是结构化 JSON，便于 AgentLoop 和测试使用。

## 4. 命令系统演示

```bash
mini-agent command run "echo hello"
mini-agent command run "npm test"
```

讲解点：

- 命令结果包含 stdout、stderr、exitCode、durationMs。
- 命令有超时和输出截断。
- 危险命令会被 PermissionManager 拦截。

可以演示危险命令拦截：

```bash
mini-agent command run "sudo reboot"
```

## 5. Patch 演示

准备一个临时 patch 文件，例如修改 README 某一行，然后执行：

```bash
mini-agent patch preview < /tmp/demo.patch
mini-agent patch apply < /tmp/demo.patch
mini-agent diff
```

讲解点：

- `patch preview` 不落盘。
- `patch apply` 会先跑 `git apply --check`。
- 应用后可以直接看 `git diff`。

## 6. run 任务演示

先演示直接回答，不修改仓库：

```bash
mini-agent run "写一个两数之和的 C++ 代码"
```

讲解点：

- `TaskRouter` 会把独立代码片段识别为直接回答。
- 这个模式不应用 patch，不创建文件。
- 所有问答仍然会写入 session/event。

再演示仓库任务：

在当前仓库运行：

```bash
mini-agent run "阅读这个仓库，说明 CLI 入口、工具系统和 session 记录分别在哪里实现"
```

更接近真实开发的任务：

```bash
mini-agent run "给 README 增加一段说明，解释 mini-agent.config.json 为什么不应该提交到 git"
```

观察输出中的：

- plan
- tool call
- patch
- command
- result
- summary
- diff

## 7. Session 演示

列出 session：

```bash
mini-agent sessions
```

查看某次 session：

```bash
mini-agent session show <sessionId>
mini-agent session events <sessionId>
```

也可以直接看文件：

```bash
find .mini-agent -maxdepth 2 -type f
```

讲解点：

- `.mini-agent/sessions` 保存会话状态。
- `.mini-agent/events` 保存时间线事件。
- JSONL 便于追加和人工排查。

## 8. 面试讲解顺序

推荐按这个顺序讲：

1. 为什么做：想复刻一个简化版 Codex CLI/Claude Code。
2. 怎么跑：`mini-agent run "任务"`。
3. TaskRouter：简单问答直接回答，仓库任务才进 AgentLoop。
4. AgentLoop：模型只给决策，执行由本地受控代码完成。
5. ToolRegistry：统一 schema、权限、错误包装。
6. 安全边界：路径、patch check、命令拦截、超时。
7. Session：每一步可追溯。
8. 取舍：删掉后端和前端，专注 CLI Agent 本体。

## 9. 常见问题

### mini-agent: command not found

说明还没有执行 `npm link`，或者当前 shell PATH 没有 Node 全局 bin。

解决：

```bash
cd /home/sid/miniagent/mini-coding-agent
npm link
mini-agent --help
```

或直接：

```bash
node dist/cli/index.js --help
```

### mini-agent 没有输出

旧版本在 `npm link` 场景下可能因为 symlink 入口判断失败直接退出。当前版本已修复，重新 build 即可：

```bash
npm run build
mini-agent --help
```

### 模型调用失败

检查：

```bash
mini-agent config show
```

确认：

- `baseUrl` 正确。
- `apiKey` 有值。
- `model` 有值。
- 当前网络能访问模型服务。

### search_code 失败

确认安装了 ripgrep：

```bash
rg --version
```

Ubuntu 安装：

```bash
sudo apt install ripgrep
```
