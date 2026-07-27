# 面试演示脚本

这份脚本只保留三组能够体现项目差异的演示：

1. 同一句自然语言如何编译成不同权限；
2. Writer、Reviewer 和主 Agent 如何在隔离工作区协作；
3. 长对话与上下文压缩后，系统如何保持 artifact 指代。

工具列表、RAG、MCP、Memory 等能力可以在追问时展示，不要在开场逐条执行。

## 演示目标

面试官应在十分钟内看到四件事：

- 这不是一个直接调用模型的聊天壳；
- 模型负责提出决策，本地运行时负责权限、工具和完成条件；
- 子 Agent 可以真正修改和验证，但不能直接污染父工作区；
- 终端能够解释发生了什么，同时不暴露隐藏思维链。

## 1. 演示前准备

使用一个临时克隆，避免演示任务修改主仓库：

```bash
cd /path/to/mini-coding-agent
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm link --global

DEMO_ROOT="$(mktemp -d)"
git clone . "$DEMO_ROOT/mini-coding-agent-demo"
cp mini-agent.config.json "$DEMO_ROOT/mini-coding-agent-demo/mini-agent.config.json"
cd "$DEMO_ROOT/mini-coding-agent-demo"
pnpm install --frozen-lockfile
mini-agent doctor
```

若 `pnpm` 不在 `PATH`，将命令中的 `pnpm` 替换为 `corepack pnpm`。

如果使用环境变量配置模型，可以跳过复制配置文件。

演示前确认：

- `doctor` 能识别 Node、Git、ripgrep 和模型配置；
- Git 工作区干净；
- 模型 Endpoint 可用；
- 终端宽度足以显示时间线；
- 不在真实业务仓库演示写入任务。

## 2. 演示一：语义理解与最小权限

先运行只读分析：

```bash
mini-agent run \
  "只分析 src/agent/TaskUnderstandingResolver.ts 的职责，不要修改任何文件" \
  --verbose
```

需要讲解：

- 请求进入统一 `AgentLoop`，不是单独的“代码审查程序”。
- `TaskUnderstanding` 识别 Repository Analysis 和显式只读约束。
- Task Contract 只开放仓库读取，不开放 Patch 和命令。
- 模型即使错误提出写入，也会被本地契约阻断。

然后展示否定套否定：

```bash
mini-agent run \
  "不是让你只分析：检查 src/agent/TaskUnderstandingResolver.ts，发现问题就直接修复并验证" \
  --verbose
```

需要讲解：

- 这类复杂否定会进入 Schema 约束的模型语义消歧。
- 语义候选不能单独授予写权限；`operation` 和 `explicitMutation` 必须一致。
- 最终 Task Contract 是权限事实源，后续模块不会再用原句关键词重新猜权限。

演示时不要求第二条一定发现真实 Bug。若没有问题，正确行为是基于证据说明未修改，而不是为了完成任务制造 Patch。

## 3. 演示二：Writer → Reviewer → Parent Merge

在临时克隆中执行：

```bash
mini-agent run \
  "使用两个 subagent：writer 新增 src/utils/clamp.ts 和 tests/utils/clamp.test.ts，实现 clamp(value, min, max)，非有限数或 min 大于 max 时抛错；reviewer 审查实现和测试；通过后由主 agent 合入并运行相关测试。" \
  --trace
```

观察时间线中的：

- `[understanding]` 与 Task Contract；
- `DELEGATE` 和任务依赖；
- Writer 的 disposable worktree 与基线指纹；
- 子 Agent 在隔离工作区应用 Patch；
- 允许列表中的测试/类型检查命令；
- Reviewer 读取物化后的 Writer 修改；
- 主 Agent 的 `APPLY_DELEGATED_PATCH`；
- 父级验证；
- `Changes` 卡片和最终 Diff。

讲解顺序：

1. 子 Agent 不是预先写死的脚本角色，而是由自然语言任务意图触发。
2. Writer 修改临时 worktree，不直接触碰父工作区。
3. Reviewer 依赖 Writer，因此审查的是修改后的真实文件。
4. 父级在合入前比较基线指纹并重新检查 Patch。
5. 若父工作区并发变化造成冲突，运行时返回 `DELEGATED_PATCH_CONFLICT`，要求重新委派。
6. 主 Agent 合入后仍要完成父级验证，不能把子级成功直接当作整体成功。

演示后查看：

```bash
git status --short
mini-agent diff
mini-agent changes --limit 3
mini-agent sessions
```

## 4. 演示三：Artifact 追问与上下文

启动交互模式：

```bash
mini-agent
```

依次输入：

```text
> 创建一个独立的 HTML 贪吃蛇游戏，保存在 examples 目录
> 文件在哪里
> 只解释刚才文件的位置，不要继续修改
```

正确观察点：

- 第一轮应创建真实文件并记录 `FILE_CHANGE`/Artifact。
- “文件在哪里”应解析为最近产物追问。
- 回答应优先给出仓库相对路径，而不是介绍 Mini Agent 自己在哪里运行。
- 第三轮应保持只读，不再修改文件。

随后可以继续几轮无关对话并执行：

```text
> /compact
> 刚才那个游戏文件叫什么
```

讲解：

- Conversation、Context、Session Memory 和 Prompt Cache 是不同层。
- `/compact` 只压缩任务上下文记录，不代表服务商 Prompt Cache。
- Artifact 与最近 exchange 的选择策略用于保持指代，不靠固定句子回复。

## 5. 可选演示：终端可观察性

同一个只读任务分别运行：

```bash
mini-agent run "解释当前 ContextBuilder 的输入来源"
mini-agent run "解释当前 ContextBuilder 的输入来源" --verbose
mini-agent run "解释当前 ContextBuilder 的输入来源" --trace
```

展示层级：

- 默认：阶段、结果、基础 Token 和 Changes。
- `--verbose`：工具参数、Context 压缩、缓存和时延。
- `--trace`：脱敏后的完整结构化 Decision 与 Context Section 分配。

需要明确：

- `reasoning_tokens` 是服务商用量字段；
- 原始隐藏思维链不会显示；
- 可审计原因来自显式计划、Decision、Tool evidence 和 Guardrail。

## 6. Web 能力为何不作为主演示

可以使用：

```bash
mini-agent run "联网确认 TypeScript 当前稳定版本，并引用来源" --verbose
```

但 Web 结果受搜索服务、网络和页面可访问性影响，不适合作为唯一现场演示。它更适合说明：

- 查询范围不能被擅自加强；
- 搜索结果不是最终证据；
- URL 必须来自本轮搜索或抓取；
- 时效最高级需要比较候选；
- 搜索失败时应诚实报告证据不足，而不是猜 URL。

如果现场网络不稳定，直接展示已有 Session Event 或自动化测试，不要反复重试。

## 7. 十分钟讲解节奏

推荐顺序：

1. 1 分钟：问题与定位——为什么聊天模型不能直接成为 Coding Agent。
2. 2 分钟：单 AgentLoop、TaskUnderstanding 和 Task Contract。
3. 3 分钟：Writer/Reviewer worktree 演示。
4. 2 分钟：Artifact 追问、Context 与终端时间线。
5. 1 分钟：测试和 AgentBench。
6. 1 分钟：真实边界——模型质量、搜索提供商和应用层沙箱。

不要从 API 参数、功能数量或“对标 Claude Code”开始讲。

## 8. 常见现场问题

### `mini-agent: command not found`

```bash
pnpm build
pnpm link --global
mini-agent --help
```

或直接：

```bash
node dist/cli/index.js --help
```

### 模型调用失败

```bash
mini-agent doctor
mini-agent config show
```

检查 Endpoint 是否为 OpenAI-compatible Chat Completions 接口、模型名是否正确、API Key 是否已配置。`config show` 会脱敏输出密钥。

### 子 Agent 没有启动

确认：

- 当前是仓库任务，而不是 Direct Answer；
- 配置中的 `multiAgent.mode` 不是 `off`；
- 用户表达了明确委派，或任务确实适合自动拆分；
- 可用并发数大于 1。

`--agents 2` 可以覆盖并发数，但不应把它讲成唯一的功能开关。

### Writer 或 Reviewer 失败

这是可展示的失败路径。查看终端中的：

- protocol recovery；
- child command exit code；
- verification；
- task exhaustion；
- dependency cancellation；
- worktree cleanup。

不要让主 Agent 在必需子任务失败后偷偷代写；当前运行时会把这种情况作为失败闭包处理。

### 如何恢复干净演示环境

直接离开并删除临时克隆即可。不要在主项目中使用 `git reset --hard` 清理演示。
