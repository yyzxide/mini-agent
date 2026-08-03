# mini-coding-agent 中文文档

> 文档集最近全量核对：2026-08-03。当前事实以源码、`pnpm verify` 和[项目现状](PROJECT_STATUS.md)为准；历史章节不用于推断现有运行时。

这里是项目文档的统一入口。文档按“当前事实、历史演进、使用指南、求职材料”分层，避免旧设计记录与现行架构互相覆盖。

## 推荐阅读顺序

第一次了解项目时，按以下顺序阅读即可：

1. [项目 README](../../README.md)：定位、快速开始、三组演示和能力边界。
2. [架构设计](ARCHITECTURE.md)：当前运行时与控制平面。
3. [架构演进](ARCHITECTURE_EVOLUTION.md)：项目为什么从 A 走到 B。
4. [项目现状](PROJECT_STATUS.md)：已验证能力、真实短板和成熟度。
5. [演示脚本](DEMO_SCRIPT.md)：面试时可重复执行的三组场景。

## 当前事实文档

这些文件描述当前版本，代码变化后应优先同步：

| 文档 | 内容 | 维护原则 |
| --- | --- | --- |
| [架构设计](ARCHITECTURE.md) | AgentLoop、TaskFrame、TaskContract、Context、证据、子代理和终端事件 | 只描述当前实现 |
| [项目现状](PROJECT_STATUS.md) | 能力清单、验证基线、产品边界和剩余风险 | 不使用主观百分制评分 |
| [测试计划](TEST_PLAN.md) | 自动化、场景测试、手工验收和提交前命令 | 与真实测试和 CLI 保持一致 |
| [Roadmap](ROADMAP.md) | 已完成能力与有限的下一步 | 不把“可做”全部写成“必须做” |

若这些文档与历史记录冲突，以代码、自动化测试和当前事实文档为准。

## 历史与设计决策

- [架构演进](ARCHITECTURE_EVOLUTION.md)：保留每一阶段的简短 A → B 记录，包括旧限制、修改原因、当前方案和仍然存在的边界。
- [自身结构设计说明](SELF_STRUCTURE_DESIGN.md)：早期学习笔记，不是当前运行时规范；阅读时应结合架构演进和当前架构。

历史文档不会为了“看起来始终正确”而删除旧方案，但必须明确标记时间语境，不能把旧状态写成当前事实。

## 使用与验证指南

- [演示脚本](DEMO_SCRIPT.md)：权限语义、多 Agent worktree、上下文与 artifact 追问。
- [Plan 模式](PLAN_MODE.md)：只读规划与 `/execute` 闭环。
- [RAG 指南](RAG_GUIDE.md)：知识库导入、检索、Embedding 与离线评测。
- [自测清单](SELF_TEST_CHECKLIST.md)：发布前与现场演示前的分层检查。

## 求职与学习材料

这些文件服务于讲解，不定义运行时行为：

- [简历包装](RESUME_PACKAGE.md)：准确的项目定位、简历表达和不可夸大的边界。
- [面试讲解稿](INTERVIEW_GUIDE.md)：一分钟、三分钟和深入架构讲法。
- [面试问答](INTERVIEW_QA.md)：常见追问与基于当前实现的回答。
- [AI / Agent 工程学习指南](AI_STUDY_GUIDE.md)：从 Transformer、对齐和模型接口，到 Agent、RAG、Eval、MCP、安全与服务化的系统学习路线。

## 当前架构摘要

所有用户请求都进入同一个 `AgentLoop`：

```text
User request
  -> schema-validated AI TaskFrame
  -> AgentTaskContract
  -> AgentLoop
     -> ContextBuilder
     -> LLM AgentDecision
     -> Guardrails
     -> tool / patch / command / delegation
  -> session events / checkpoint / task diff / final result
```

运行时的关键原则：

- Task Contract 是每轮能力与完成条件的唯一边界。
- 开放式语义统一由模型编译为 TaskFrame；确定性代码只处理授权、安全和证据。
- 模型不能仅凭自己的标签获得仓库写权限。
- 回答、Web、Review、Repository Analysis 与 Change 使用同一个 AgentLoop，不是五套执行器。
- Writer 子代理在一次性 worktree 中修改和验证；Reviewer 读取物化后的依赖补丁；主 Agent 独占合入权。
- 终端展示结构化决策和证据，不展示隐藏思维链。
- Prompt Cache、Embedding Cache、Conversation 与 Context Compaction 是四个不同概念。

## 快速验证

项目使用 `pnpm-lock.yaml` 和固定的 pnpm 版本：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm bench
```

如果当前 Node 安装不允许 `corepack enable`，可以把下面所有 `pnpm` 替换为 `corepack pnpm`，无需全局安装 pnpm。

环境诊断：

```bash
pnpm build
node dist/cli/index.js doctor
```

自动化测试不依赖真实 API。真实模型和实时 Web 的质量需要单独的 opt-in 抽样评测，不能用一次成功对话代替稳定性结论。

真实模型重复评测可使用 `mini-agent bench run <dataset> --mode real --repetitions 5 --output <report>` 保存结果，再通过 `mini-agent bench compare <current> <baseline>` 离线比较；报告会显式显示 flaky 场景和 95% Wilson 区间。

## 文档事实维护规则

1. 测试数量不写入长期文档；只记录验证日期和门禁是否通过，具体数量以当次 `pnpm verify` 输出为准。
2. README 只保留能够帮助第一次访问者理解和运行项目的信息。
3. 架构演进保留旧方案，但当前架构不重复维护旧状态。
4. CLI 命令以 `mini-agent --help` 为准。
5. 产品能力必须能在源码、测试或演示中找到对应证据。
6. 不使用“生产级”“完全对标”“任意任务稳定完成”等无法证明的表达。
7. 架构或外部协议基线变化后，至少同步 README、架构、项目现状、测试计划和 AI 学习指南；未变化的使用类文档只复核，不为制造 Diff 改写。

## 项目边界

这是一个作品级、工程化导向的本地 Coding Agent：

- 强项是统一运行时、能力契约、上下文治理、可审计工具链和隔离式多 Agent 协作。
- 它不是操作系统级安全沙箱。
- Web 结果仍受搜索和页面来源质量影响。
- Web Search 支持配置 Brave API 与 DuckDuckGo 降级链，但凭据、配额和真实联网质量需要单独验证。
- MCP 当前实现 `2025-11-25` 形态的 tools、静态 resources/list/read 与 prompts/list/get 子集；状态诊断会分别显示发现项、注册适配器和仍未桥接能力。这不代表完整覆盖 resource templates、订阅、认证、服务端主动请求，也不代表兼容 `2026-07-28` 无状态规范。
- JSONL/本地文件存储适合单机 CLI，不代表多租户服务架构。
- 与 Claude Code、Codex 的比较应限于设计问题和工程取舍，不能宣称产品能力等价。
