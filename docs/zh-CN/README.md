# mini-coding-agent 中文文档

这组文档面向两类场景：

1. 自己继续开发时，快速找回项目结构、验证命令和扩展方向。
2. 面试或项目汇报时，用清晰的工程语言讲明白“我做了什么、为什么这么做、边界在哪里”。

## 文档导航

- [架构设计说明](ARCHITECTURE.md)：从 TypeScript Runner、Java Backend、React Frontend、Docker Sandbox 和 Git Workflow 五层说明系统设计。
- [测试计划](TEST_PLAN.md)：定义测试阶段范围、分层策略、命令、风险项和进入/退出标准。
- [测试报告 2026-06-11](TEST_REPORT_2026-06-11.md)：记录当前基线验证结果和测试缺口。
- [面试讲解稿](INTERVIEW_GUIDE.md)：包含 30 秒、1 分钟、3 分钟版本，以及技术亮点、难点和取舍。
- [演示脚本](DEMO_SCRIPT.md)：按步骤演示 CLI、后端、前端、Docker 沙箱和 Git Workflow。
- [自测清单](SELF_TEST_CHECKLIST.md)：提交前、演示前、面试前可以逐项检查的验证表。
- [面试问答](INTERVIEW_QA.md)：整理高频问题和可直接复述的回答。
- [后续规划](ROADMAP.md)：列出短期补强、中期能力升级和长期产品化方向。

## 项目一句话

`mini-coding-agent` 是一个本地运行的对话式 AI Coding Agent 原型。它用 TypeScript 实现核心 Agent Loop 和工具调用，用 Java Spring Boot 做任务控制面，用 React 提供 Web 控制台，并通过 Docker 沙箱和 Git Workflow 支持更接近真实交付的本地开发流程。

## 当前能力快照

- 本地 CLI 可执行自然语言任务。
- Mock LLM 可跑通搜索、读文件、打补丁、执行命令、生成 diff 的闭环。
- OpenAI-compatible client 已抽象，可切换真实模型。
- 工具系统包含文件列表、文件读取、代码搜索、patch、命令执行、git status/diff。
- 本地 session 和 event 以 JSONL 记录，便于审计和恢复。
- Java 后端可启动任务、记录日志事件、读取 session、提供 SSE。
- React 前端可创建任务、查看事件、日志、diff、session 和 Git Workflow 状态。
- Docker 沙箱可隔离任务工作区，并限制网络、CPU、内存和挂载权限。
- Git Workflow 可创建任务分支、提交 diff、生成 PR 草稿。

## 推荐验证命令

从仓库根目录执行：

```bash
pnpm install
pnpm verify
```

如果本机没有全局 `pnpm` 命令，可以使用：

```bash
corepack pnpm install
corepack pnpm verify
```

如果只想分别验证：

```bash
pnpm verify:runner
pnpm verify:backend
pnpm verify:frontend
```

如果需要 Docker 沙箱：

```bash
pnpm run docker:build-sandbox
```

## 面试时的叙述主线

可以按下面顺序讲：

1. 先讲目标：做一个简化版本地 Coding Agent，而不是只做一个聊天壳。
2. 再讲闭环：任务输入、上下文构建、工具调用、权限审批、patch、测试、diff、session 审计。
3. 然后讲分层：TypeScript Runner 负责 Agent 能力，Java Backend 负责任务控制，React Frontend 负责可视化。
4. 接着讲安全：路径越权、防危险命令、patch check、Docker 沙箱、只读 runner mount、无网络模式。
5. 最后讲扩展：真实模型、修复循环、远程 PR、多用户和权限体系。

## 适合强调的工程点

- 没有把所有逻辑堆在 CLI：核心 Runner、控制面、前端和沙箱职责分开。
- 没有让模型直接操作系统：所有动作都经过工具 schema、权限和结构化记录。
- 没有把会话记录当日志附属品：session/event 是后端、前端、审计和恢复共同依赖的数据流。
- 没有假装沙箱已经解决所有安全问题：Docker 仅作为第一层隔离，仍需要路径、命令、patch 和密钥边界。
