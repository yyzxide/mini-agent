# Roadmap

> 最近核对：2026-08-03。Roadmap 只保留由真实使用、评测或发布需求驱动的工作，不再以功能数量作为完成度指标。

项目已经完成本地 Coding Agent 的主要执行闭环。Roadmap 不再罗列所有可能增加的功能，而只记录能够显著提高可靠性、可证明性或使用体验的有限方向。

已完成的 A → B 设计变化见[架构演进](ARCHITECTURE_EVOLUTION.md)，当前能力和边界见[项目现状](PROJECT_STATUS.md)。

## 已完成的主线

- 单一 `AgentLoop` + deny-by-default `AgentTaskContract`。
- 统一 `TaskFrame` 模型语义编译。
- Direct、Web、Review、Analysis、Change 共用执行生命周期。
- 结构化 Tool Registry、Zod 参数校验和权限元数据。
- 路径安全、Patch check、受控命令和验证强度。
- 工作区文件事实与 Git tracking 分层、空补丁精确诊断、文件类型感知 `verify_file`。
- Capability Registry 中 Tool 与顶层 Decision Action 分离，避免 `run_command` / `apply_patch` 伪工具协议混淆。
- TaskFrame 结构化选择产品能力 ID，Registry 统一覆盖 MCP、Session、Memory、Skills 和 AgentBench，能力事实回答不再扫描固定问句或回答正则。
- 按任务阶段分配模型输出预算、TaskFrame 有界修复与推理参数降级。
- 大文件 Token 分页与完整覆盖率门禁。
- Web 查询范围、来源血缘、时效比较和证据不足闭环。
- Session、Checkpoint、Runtime Event、Change Log 和任务级 Diff。
- Conversation、Session Context、Long-term Memory、RAG 和 Cache 分层。
- Plan 模式、Skill 全量目录与渐进读取、MCP tools/static resources/prompts 子集和 AgentBench。
- Writer/Reviewer 临时 worktree、受限验证、基线冲突和父级合入。
- 默认终端、`--verbose`、`--trace` 与机器事件流。

## P0：保持可证明性

这是当前唯一持续优先级。

### 小型代表性 AgentBench

维护少量高价值场景，而不是追求数据集规模。当前版本化数据集已经覆盖基础编辑/创建、Patch 冲突恢复、提前 Final、验证时序、只读 Plan、旧文件产物溯源、未跟踪 HTML 修改和无变化 Patch 恢复。继续增加场景只由真实故障驱动，优先候选为：

- 只读与修改权限；
- 条件修改和复杂否定；
- 跨轮产物指代与执行账本冲突；
- 完整文件审查；
- 测试失败后修复；
- Writer → Reviewer → Parent Merge；
- 父子 Patch 冲突；
- Web 搜索失败和证据不足；
- 验证器与目标类型不兼容、交替 Guardrail 循环。

每个场景记录成功条件、禁止能力、工具轨迹和失败分类。

### 真实模型抽样

默认 CI 保持确定性。定期对少数模型执行 opt-in 重复评测，观察：

- pass@1、pass@k、run pass rate、all-runs pass rate、flaky 场景和 95% Wilson 区间；
- 语义契约和权限错误；
- 工具选择；
- 平均步骤和重复动作；
- Token、缓存、时延和成本；
- Guardrail 命中与恢复率。

不要用一次成功对话替代指标。

评测框架已经能够通过 `--output` 保存报告，并用 `mini-agent bench compare <current> <baseline>` 比较总体指标与逐场景 pass rate。Roadmap 剩余工作是积累真实模型样本和解释趋势，不是继续发明另一套统计入口。

### 文档事实检查

- CLI 命令以 `--help` 为准；
- 当前能力以源码和测试为准；
- 测试数量以 `pnpm verify` 当次输出为准，不在长期文档中写死；
- 历史方案只放入架构演进；
- README 不重新膨胀成功能清单。

## P1：有限的可靠性增强

只有在真实问题再次出现时才实施。

### 语义评测

- 为 TaskFrame 生成释义、否定、条件和中英文对抗样本；
- 统计误授予权限、误拒绝修改和追问谓词丢失；
- 对 TaskFrame 首次通过率、有界修复率和 fail-closed 率做真实模型统计；
- 不恢复按具体主题编写的问句规则。

### 子 Agent 隔离

- 可选容器/系统沙箱；
- CPU、内存、时间和网络配额；
- 子级依赖安装策略；
- 更明确的语义冲突说明；
- Windows worktree 和命令允许列表验证。

应用层 worktree 已满足当前作品演示；强沙箱属于产品化方向，不是面试项目前置条件。

### Web 声明与来源

- 在现有结构化 `webClaims` 与抓取血缘校验之上，增加语义蕴含评测，区分“URL 已关联”与“来源正文真正支持结论”；
- 来源冲突摘要；
- 无正文 SPA、订阅墙、地区限制和更多站点特有软错误模板识别；
- 垂直 API 作为独立 Tool 接入，而不是继续强化通用搜索 Prompt。

Search Provider 配置链已完成：运行时可以按配置组合 Brave Search API 与 DuckDuckGo HTML/Lite，并由 `doctor` 诊断顺序和凭据。后续工作是质量评测、限流/配额遥测和更多真实 Provider fixture，不再把“可插拔 Provider”列为未实现项。

## P2：产品体验

按实际使用频率决定。

### 安装与发布

- 版本化 GitHub Release；
- npm 包发布和安装验证；
- 配置 Profile；
- macOS、Linux、Windows 最小兼容矩阵。

### MCP 协议演进

当前实现保留 `2025-11-25` 的 tools、静态 resources/list/read 和 prompts/list/get 子集。resource templates、订阅、completion、OAuth 与服务端主动请求仍未实现。只有出现真实互操作需求时，才评估迁移到 `2026-07-28` 的无状态 core、`server/discover`、每请求 `_meta`、InputRequiredResult 和 Extensions；迁移必须通过版本协商与双版本 fixture 证明，不能只改协议版本字符串。

### 终端体验

当前事件协议已经支持继续扩展：

- 可折叠工具结果；
- 固定任务/Token/Context 面板；
- Session Replay；
- 步骤跳转和错误聚焦。

不急于建设 Web 控制台。若未来增加 TUI，应复用 `AgentRuntimeEvent`，不能产生第二套运行时状态。

### 存储

本地 JSONL 足以支持单用户 CLI。只有在出现并发、查询或迁移瓶颈时再评估：

- SQLite/FTS；
- 向量存储；
- 统一 schema migration；
- 跨仓库或跨设备同步。

## 明确暂不做

- 业务后台和多用户管理；
- 远程自动创建 PR；
- 自建基础模型；
- 任意数量的 Agent 角色；
- 为了展示而增加 Web 页面；
- 让默认 CI 依赖真实 API；
- 宣称完整 MCP 协议兼容；
- 用硬编码回答修复单个测试问句。

## 停止条件

当以下条件满足时，应优先准备面试或投入新的业务项目，而不是继续扩张：

- 三组核心演示可重复；
- 自动化验证稳定；
- README、架构和项目现状一致；
- 关键失败路径有回归；
- 能清楚说明设计边界。

当前项目已经基本达到这个停止条件。后续修改应由真实使用问题驱动。
