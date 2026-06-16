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

## 文档索引

- [架构设计说明](ARCHITECTURE.md)：解释 CLI Agent 的模块拆分、工具系统、权限、session 和 LLM 接入。
- [演示脚本](DEMO_SCRIPT.md)：用于本地演示和录屏的操作步骤。
- [面试讲解稿](INTERVIEW_GUIDE.md)：把项目讲成一个完整工程故事。
- [面试问答](INTERVIEW_QA.md)：常见追问和回答。
- [测试计划](TEST_PLAN.md)：CLI 项目的自动化和手工测试范围。
- [自测清单](SELF_TEST_CHECKLIST.md)：提交前按项检查。
- [Roadmap](ROADMAP.md)：后续增强方向。

## 一句话介绍

这是一个 TypeScript 实现的本地 AI Coding Agent CLI。它可以在任意 git 仓库中接收自然语言任务，通过受控工具搜索代码、读取文件、读取公网文档、应用补丁、执行命令、查看测试反馈，并把整个过程记录到本地 JSONL session。

## 核心能力

- 真实 OpenAI-compatible API 接入。
- 统一 ToolRegistry 和 zod 参数校验。
- `list_files`、`read_file`、`search_code`、`fetch_url`、`git_status`、`git_diff`、`apply_patch`。
- 命令执行超时、输出截断和危险命令拦截。
- patch 应用前 `git apply --check`。
- `.mini-agent/sessions` 和 `.mini-agent/events` 本地审计记录。
- `mini-agent config` 管理本地模型配置。
- `mini-agent --help`、`mini-agent run`、`mini-agent tool` 等调试命令。

## 快速验证

```bash
npm install
npm run build
npm test
npm link
mini-agent --help
mini-agent tool list
```

配置真实模型：

```bash
cp mini-agent.config.example.json mini-agent.config.json
```

然后编辑 `mini-agent.config.json` 中的 `baseUrl`、`apiKey` 和 `model`。

## 项目边界

当前版本故意不包含：

- Web 页面。
- Java 后端。
- Swagger。
- Docker 控制面。
- 远程 PR 自动创建。

如果要做企业后台或软件商店后台，建议作为独立项目实现，不混进这个 CLI Agent 仓库。
