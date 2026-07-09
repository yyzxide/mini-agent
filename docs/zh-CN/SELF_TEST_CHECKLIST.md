# 自测清单

提交前按这份清单检查纯 CLI 版本。

## 1. 环境

```bash
node --version
npm --version
git --version
rg --version
```

要求：

- Node.js 20+
- git 可用
- ripgrep 可用

## 2. 安装和构建

```bash
cd /home/sid/miniagent/mini-coding-agent
npm install
npm run build
npm run test:regression
npm test
npm run verify
```

期望：

- TypeScript 编译通过。
- 对话级回归测试通过。
- Vitest 全部通过。
- `verify` 只验证 CLI 项目。

## 3. 全局命令

```bash
npm link
mini-agent --help
mini-agent tool list
mini-agent doctor
```

期望：

- `mini-agent --help` 输出命令列表。
- `tool list` 输出工具 JSON。
- `doctor` 输出 Node、git、rg、配置和本地记录状态。

如果 `mini-agent: command not found`，说明没有 link 或 PATH 没包含 Node 全局 bin。

## 4. 配置文件

```bash
cp mini-agent.config.example.json mini-agent.config.json
mini-agent config show
```

检查：

- `mini-agent.config.json` 不进入 git。
- `config show` 默认隐藏 apiKey。
- `config show --raw` 只在本地排查时使用。

## 5. 工具系统

```bash
mini-agent tool run list_files '{"path":"src","maxDepth":2}'
mini-agent tool run read_file '{"path":"README.md","maxLines":20}'
mini-agent tool run search_code '{"query":"AgentLoop","path":"src","maxResults":5}'
mini-agent tool run web_search '{"query":"TypeScript latest release","maxResults":3}'
mini-agent tool run fetch_url '{"url":"https://example.com"}'
mini-agent tool run git_status '{}'
mini-agent tool run git_diff '{}'
```

期望：

- 输出结构化 JSON。
- `read_file` 有行号和内容。
- `search_code` 能返回路径、行号和文本。
- `fetch_url` 能返回公网文本内容。
- git 工具在 git 仓库里正常。

## 6. 路径安全

```bash
mini-agent tool run read_file '{"path":"../README.md"}'
```

期望：

- 返回结构化错误。
- 错误 message 能说明路径越过仓库边界。

## 7. 命令执行

```bash
mini-agent command run "echo hello"
mini-agent command run "npm test"
```

期望：

- 返回 stdout、stderr、exitCode、durationMs。
- 成功命令 `success: true`。

危险命令拦截：

```bash
mini-agent command run "sudo reboot"
```

期望：

- 被 PermissionManager 拦截。
- 不实际执行。

## 8. Patch

准备一个只修改普通文件的 unified diff：

```bash
mini-agent patch preview < /tmp/demo.patch
mini-agent patch apply < /tmp/demo.patch
mini-agent diff
```

期望：

- preview 不落盘。
- apply 前会 check。
- apply 后 `mini-agent diff` 能看到变更。

## 9. Agent 真实任务

配置好真实模型后：

直接回答任务：

```bash
mini-agent run "给我一个两数之和的 C++ 代码片段，不要改文件"
mini-agent run "非登记收款人是什么意思"
```

期望：

- 输出 `[answer]`。
- 不创建源码文件。
- 不出现 `[patch]`。

代码落文件任务：

```bash
mini-agent run "写一个两数之和的 C++ 代码"
```

期望补充检查：

- 会进入 `AGENT_LOOP` 而不是纯 `[answer]`。
- 仓库里会生成新文件，例如 `two_sum.cpp`。
- 输出里应该出现 `[patch]` 和最终总结。

短追问承接任务：

```text
mini-agent
> 给我一个 Python 代码片段，写一个两数之和
> 写进去
```

期望补充检查：

- 第二轮不能再问“你想写什么内容到哪个文件”。
- 应该直接进入文件落盘流程。
- 仓库里会生成新文件。
- 输出中应出现 `[patch]`。

连续算法追问：

```text
mini-agent
> 帮我写个 最长有效括号
> 数据流的中位数呢
```

期望补充检查：

- 第二轮不能只输出代码块。
- 第二轮仍然应该进入 `AGENT_LOOP`。
- 仓库中应该新增或修改一个中位数相关文件，例如 `median_finder.ts`。
- 输出中应出现 `[patch]` 和最终总结。

写入确认：

```text
mini-agent
> 给我一个 TypeScript 代码片段，写一个数据流中位数
> 你写入了嘛？
```

期望补充检查：

- 如果上一轮只是 `[answer]`，这里必须回答没有查到文件写入记录。
- 不能把更早之前的其它文件变更误说成刚才已经写入。
- 如果上一轮确实走了 `[patch]`，这里应该列出 session 中记录的变更文件。

联网回答任务：

```bash
mini-agent run "联网搜索一下 TypeScript 最新版本信息"
mini-agent run "洛克王国最新版本是什么，最新的宠物有哪些"
mini-agent run "edg在哪一年中夺冠了"
```

期望：

- 输出 `[tool] web_search`。
- 如搜索结果可抓取，输出 `[tool] fetch_url`。
- 最终输出 `[answer]`，而不是仓库任务的 `[summary]`。
- 不创建源码文件。
- 对 EDG 这类多项目俱乐部，未指定游戏时不要只默认《英雄联盟》，应按项目列出主要冠军或提示用户补充范围。

交互模式下的联网追问：

```text
mini-agent
> 世界杯最新比分
> 日本队最近几场的成绩
```

期望：

- 第二问仍然输出 `[answer]`。
- 第二问的回答范围应继承“世界杯”，不要混入友谊赛、世预赛或其它赛事，除非用户明确要求所有比赛。

仓库任务：

```bash
mini-agent run "阅读这个仓库，说明 src/tools 和 src/agent 的职责"
```

期望：

- Agent 能调用工具读取仓库。
- 最终输出 summary。
- `.mini-agent/sessions` 和 `.mini-agent/events` 有新记录。

## 10. Session

```bash
mini-agent sessions
mini-agent session show <sessionId>
mini-agent session events <sessionId>
mini-agent logs
mini-agent changes
```

期望：

- 能列出历史 session。
- 能查看消息、工具、命令、patch 和最终 diff。
- 能查看运行日志和任务变更日志。

## 10.1 交互式命令

```text
mini-agent
> /help
> /session
> /history 10
> /events 10
> /logs 10
> /changes 10
> /compact
> /new
> /sessions
> /exit
```

期望：

- `/help` 显示完整 slash 命令。
- `/history` 和 `/events` 能查看当前 session 的记录。
- `/compact` 会写入压缩记忆记录。
- `/logs` 和 `/changes` 能查看最近运行记录。

## 11. Git 状态

提交前：

```bash
git status --short
git diff --check
```

期望：

- 没有意外文件。
- 没有空白错误。
- `mini-agent.config.json` 不出现在待提交列表。

## 12. 演示验收

最小演示链路：

```bash
mini-agent --help
mini-agent tool list
mini-agent tool run read_file '{"path":"README.md"}'
mini-agent command run "echo hello"
mini-agent run "总结这个项目的核心模块"
mini-agent sessions
mini-agent logs
mini-agent changes
mini-agent diff
```

这条链路能跑通，就说明纯 CLI MVP 是健康的。
期望补充检查：

- 会进入 `AGENT_LOOP` 而不是纯 `[answer]`。
- 仓库里会生成新文件，例如 `two_sum.cpp`。
- 输出里应该出现 `[patch]` 和最终总结。
