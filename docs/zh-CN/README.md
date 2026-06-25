# mini-coding-agent 中文文档

`mini-coding-agent` 现在定位为一个纯本地运行的 AI Coding Agent CLI。

它不再内置 Java 后端、Web 前端或沙箱控制面。项目主线收敛为：

```text
自然语言任务
-> 构建仓库上下文
-> 调用真实大模型
-> 搜索/读取代码
-> 生成并应用 patch
-> 执行命令或测试
-> 根据失败日志继续修复
-> 输出总结和 git diff
-> 保存本地 session/event
```

普通聊天、独立代码片段和联网问答不会强行进入代码修改循环。当前版本会先用 `TaskRouter` 分成三类：

- `DIRECT_ANSWER`：普通问答、解释、独立代码片段，输出 `[answer]`。
- `WEB_ANSWER`：需要最新资料或公网信息的问题，先执行 `web_search` / `fetch_url`，再输出更完整的 `[answer]`。
- `AGENT_LOOP`：真正的仓库阅读、修改、测试和修复任务，输出 `[plan]`、`[tool]`、`[patch]`、`[command]`、`[summary]`。

`WEB_ANSWER` 不是简单把用户原话丢给搜索引擎。它会先用 `WebQuestionPlanner` 结合 session 记忆生成独立问题、搜索 query、回答范围、来源提示和回答约束；规划失败时再用本地 fallback 策略补齐追问范围和 source-focused query。

## 文档索引

- [架构设计说明](ARCHITECTURE.md)：解释 CLI Agent 的模块拆分、工具系统、权限、session 和 LLM 接入。
- [演示脚本](DEMO_SCRIPT.md)：用于本地演示和录屏的操作步骤。
- [面试讲解稿](INTERVIEW_GUIDE.md)：把项目讲成一个完整工程故事。
- [面试问答](INTERVIEW_QA.md)：常见追问和回答。
- [测试计划](TEST_PLAN.md)：CLI 项目的自动化和手工测试范围。
- [自测清单](SELF_TEST_CHECKLIST.md)：提交前按项检查。
- [Roadmap](ROADMAP.md)：后续增强方向。

## 一句话介绍

这是一个 TypeScript 实现的本地 AI Coding Agent CLI。它可以在任意 git 仓库中接收自然语言任务，通过受控工具搜索代码、读取文件、搜索公网资料、读取公网文档、应用补丁、执行命令、查看测试反馈，并把整个过程记录到本地 JSONL session。

## 核心能力

- 真实 OpenAI-compatible API 接入。
- 普通问答、联网问答、仓库任务三种模式分流。
- 统一 ToolRegistry 和 zod 参数校验。
- `list_files`、`read_file`、`search_code`、`web_search`、`fetch_url`、`git_status`、`git_diff`、`apply_patch`。
- 命令执行超时、输出截断和危险命令拦截。
- patch 应用前 `git apply --check`。
- `.mini-agent/sessions` 和 `.mini-agent/events` 本地审计记录。
- `.mini-agent/logs` 运行日志和 `.mini-agent/change-log.jsonl` 任务变更日志。
- `mini-agent config` 管理本地模型配置。
- `mini-agent --help`、`mini-agent run`、`mini-agent tool`、`mini-agent doctor`、`mini-agent logs`、`mini-agent changes` 等调试命令。

## 快速验证

```bash
npm install
npm run build
npm test
npm link
mini-agent --help
mini-agent tool list
mini-agent doctor
```

配置真实模型：

```bash
cp mini-agent.config.example.json mini-agent.config.json
```

然后编辑 `mini-agent.config.json` 中的 `baseUrl`、`apiKey` 和 `model`。

交互模式常用命令：

```text
/help         查看命令帮助
/new          新开会话
/resume <id>  切换到历史 session
/history [n]  查看当前 session 最近记录
/events [n]   查看当前 session 最近事件
/logs [n]     查看运行日志
/changes [n]  查看任务变更日志
/compact      写入一条本地压缩记忆
/status       查看仓库状态摘要
/diff         查看 git diff
/exit         结束会话
```

## 项目边界

当前版本故意不包含：

- Web 页面。
- Java 后端。
- Swagger。
- Docker 控制面。
- 远程 PR 自动创建。

如果要做企业后台或软件商店后台，建议作为独立项目实现，不混进这个 CLI Agent 仓库。
