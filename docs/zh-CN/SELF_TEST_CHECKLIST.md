# 自测清单

这份清单用于发布前、重要重构后和面试演示前的分层验证。默认自动化测试保持确定性；真实模型和 Web 检查单独执行。

## 1. 提交前自动化

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm bench
git diff --check
```

若无法直接执行 `pnpm`，使用 `corepack pnpm`；CI 中由 `pnpm/action-setup` 提供命令。

通过条件：

- 所有命令退出码为 0；
- 没有临时 child worktree 残留；
- 没有意外修改 `.mini-agent`、配置密钥或用户暂存区；
- 新增能力同时具有权限失败路径和回归测试。

检查 worktree：

```bash
git worktree list --porcelain
```

## 2. CLI 烟雾测试

```bash
pnpm build
node dist/cli/index.js --help
node dist/cli/index.js run --help
node dist/cli/index.js doctor
node dist/cli/index.js tool list
node dist/cli/index.js tool manifest
node dist/cli/index.js sessions
```

确认：

- Help 中命令与 README 一致；
- `doctor` 识别 Node、Git、ripgrep、包管理器和脱敏配置；
- Tool Manifest 包含权限与 open-world/read-only 等元数据；
- 无模型配置时给出明确诊断，而不是未捕获异常。

## 3. 工具和路径安全

正常读取：

```bash
mini-agent tool run list_files '{"path":"src","maxDepth":2}'
mini-agent tool run read_file '{"path":"README.md","maxLines":40}'
mini-agent tool run search_code '{"query":"AgentLoop","path":"src","maxResults":10}'
mini-agent tool run git_status '{}'
mini-agent tool run git_diff '{}'
```

拒绝路径：

```bash
mini-agent tool run read_file '{"path":"../README.md"}'
mini-agent tool run read_file '{"path":".git/config"}'
mini-agent tool run search_code '{"query":"HEAD","path":".git"}'
```

确认：

- 仓库外路径与内部元数据路径被拒绝；
- 错误为结构化结果；
- Windows/POSIX 路径输出保持稳定；
- 搜索中的异常行不会拖垮整个结果。

## 4. Patch 和命令安全

```bash
mini-agent command run "echo hello"
mini-agent command run "pnpm test"
mini-agent command run "sudo reboot"
```

确认：

- 普通结构化命令返回 stdout、stderr、exitCode 和 duration；
- 高风险命令需要明确批准或被拒绝；
- Shell 语法不会在默认结构化执行中隐式生效；
- 输出和超时有边界。

Patch 使用临时演示仓库验证：

```bash
mini-agent patch preview < /tmp/demo.patch
mini-agent patch apply < /tmp/demo.patch
mini-agent diff
```

确认：

- 非法 Patch 在 preview/check 阶段失败；
- Apply 不改变真实 Git 暂存区；
- Diff 包含新文件；
- 任务开始前已有脏改动不会混入本轮任务 Diff。

## 5. 任务理解和权限

### 只读约束

```bash
mini-agent run "只分析 src/agent/AgentLoop.ts，不要修改文件" --verbose
```

预期：

- TaskFrame 目标为 `REPOSITORY`，效果保持只读；
- 允许仓库读取；
- 禁止 Patch 和命令；
- 工作区不变。

### 否定套否定

```bash
mini-agent run "不是让你只分析，发现问题就直接修复并验证" --verbose
```

预期：

- TaskFrame 正确表达复杂否定，且没有本地关键词路由；
- 结构化语义结果进入事件；
- 写权限只在最终语义一致时授予；
- 不依赖固定完整问句。

TaskFrame 的一次有界修复和 fail-closed 使用自动化夹具验证，不能指望一次真实模型手工运行同时覆盖三个互斥分支。

### 条件修改

```bash
mini-agent run "如果测试能复现这个问题就修复，否则只报告证据" --trace
```

预期：

- 条件和操作边界进入 TaskFrame；
- 没有复现时不为了满足“修改任务”制造 Patch；
- 最终结果说明采取了哪个分支。

## 6. 大文件与完整覆盖

对超过默认单页 Token 预算的文件运行：

```bash
mini-agent review path/to/large-file.ts
```

确认：

- `read_file` 通过 nextStartLine/nextStartColumn 继续；
- sourceVersion 在分页中一致；
- 覆盖区间合并；
- 未覆盖到 EOF 时 `FINAL` 被拒绝；
- 终端显示读取进度而不倾倒全部文件内容。

同时验证超长单行、空文件和不存在文件。

## 7. 多 Agent

在临时克隆中运行：

```bash
mini-agent run \
  "使用两个 subagent：一个实现小功能，一个 review；通过后由主 agent 合入并测试" \
  --trace
```

确认：

- Writer 使用临时 worktree；
- Writer 可以应用多次 Patch；
- 只允许受限验证命令；
- Reviewer 等待 Writer 并读取物化修改；
- 主 Agent 独占合入；
- 父级验证发生在合入之后；
- 结束后没有 worktree 残留。

失败路径：

- Writer 返回非法 Decision；
- Writer 最新验证失败；
- Reviewer 耗尽步骤；
- 依赖失败取消后续任务；
- 子级运行期间修改父级同一位置；
- 父级变化但 Patch 仍可干净应用；
- 必需 Writer 失败后主 Agent 不代写。

## 8. Conversation、Context 与 Artifact

交互式执行：

```text
> 创建一个独立的 HTML 游戏文件
> 文件在哪里
> 只解释位置，不要修改
> /compact
> 刚才那个文件叫什么
```

确认：

- “文件在哪里”指向最近 Artifact；
- 回答仓库路径，不介绍 Agent 产品身份；
- `/compact` 后关键 Artifact 和约束仍可召回；
- Conversation 消息数、Context 预算和 Prompt Cache 分开显示；
- 新 Session 不召回无关旧 Session 事实。

再构造两个不同 Artifact，确认“第一个”“第二个”“最近那个”的指代不会混淆。

## 9. Web 研究（可选、非 CI）

```bash
mini-agent run "联网确认 TypeScript 当前稳定版本，并引用来源" --verbose
```

确认：

- 第一条查询保留用户范围；
- 搜索后抓取重要来源；
- 最终引用只来自本轮 URL；
- 时效结论比较日期/版本候选；
- 搜索失败后不猜测 URL；
- 证据不足可以成功输出限制说明；
- 不因 Guardrail 重复拒绝直到最大步数。

使用 Mock/Scripted Client 分别注入：

- 搜索 Transport 失败；
- 搜索成功但抓取失败；
- 旧版本排名靠前；
- 官方来源与二手来源冲突；
- 接近综合回答预留步数。

## 10. Plan、Memory、RAG、Skill 和 MCP

Plan：

```bash
mini-agent plan "为项目增加一个新工具"
```

确认 Plan 过程中没有 Patch、命令或非只读工具；`/execute` 只执行当前 Session 最近一份成功计划。

Memory/RAG：

```bash
mini-agent memory stats
mini-agent rag stats
mini-agent rag ingest README.md docs/zh-CN --tag project
mini-agent rag search "Task Contract 如何限制权限" --top-k 3
mini-agent tool run knowledge_index '{"paths":["README.md","docs/zh-CN"]}'
```

确认自动 Memory 写入只接受允许的语义类型和有证据结果；RAG 引用包含来源与行号，证据不足时拒答；修改已索引源文件后应得到 `STALE_INDEX/staleSources`，Agent 必须执行 `knowledge_index` 后再次搜索。

Skill/MCP：

```bash
mini-agent skill list
mini-agent mcp status
mini-agent mcp tools
```

创建一个带 `references/*.md` 的临时 Skill，确认无关键词命中时 Context 仍含有界 catalog，模型可用 `skill_read` 分页读取完整说明与文本资源，且二进制/路径逃逸被拒绝。确认 Skill 和 MCP 不能绕过当前 Task Contract；远端工具/resource/prompt adapter 名称隔离、目标 allowlist、权限映射和 untrusted 标记正确，三类 list 能跨 cursor 分页；人为让 prompts/list 失败时，tools/resources 仍应保留且状态显示 degraded。Server 生命周期必须关闭。

真实模型最终验收：

```bash
mini-agent bench accept --repetitions 3
```

检查 `.mini-agent/bench/real-model-acceptance-latest.json` 和同名 Markdown，不能只看一次成功输出。

## 11. Session 与恢复

```bash
mini-agent sessions
mini-agent session show <sessionId>
mini-agent session events <sessionId>
mini-agent session summary <sessionId>
mini-agent logs
mini-agent changes
```

确认：

- 完成任务不会把 Working Set 泄漏给下一轮；
- 中断中的 in-flight action 恢复后先检查仓库状态；
- 已完成/失败 Checkpoint 不会被再次恢复；
- Event、Runtime Log 和 Change Log 职责不同；
- 敏感配置被脱敏。

## 12. 面试前最小检查

时间有限时只执行：

```bash
pnpm verify
pnpm lint:unused
mini-agent doctor
git status --short
```

然后在临时克隆中跑三组演示：

1. 只读与修改权限差异；
2. Writer → Reviewer → Parent Merge；
3. 跨轮产物指代、执行账本与 `/compact`。

Web、MCP 和真实 Embedding 不作为唯一主演示，避免外部环境决定现场结果。
