# Roadmap

项目已经完成本地 Coding Agent 的主要执行闭环。Roadmap 不再罗列所有可能增加的功能，而只记录能够显著提高可靠性、可证明性或使用体验的有限方向。

已完成的 A → B 设计变化见[架构演进](ARCHITECTURE_EVOLUTION.md)，当前能力和边界见[项目现状](PROJECT_STATUS.md)。

## 已完成的主线

- 单一 `AgentLoop` + deny-by-default `AgentTaskContract`。
- 统一 `TaskUnderstanding` 与条件式模型语义补全。
- Direct、Web、Review、Analysis、Change 共用执行生命周期。
- 结构化 Tool Registry、Zod 参数校验和权限元数据。
- 路径安全、Patch check、受控命令和验证强度。
- 大文件 Token 分页与完整覆盖率门禁。
- Web 查询范围、来源血缘、时效比较和证据不足闭环。
- Session、Checkpoint、Runtime Event、Change Log 和任务级 Diff。
- Conversation、Session Context、Long-term Memory、RAG 和 Cache 分层。
- Plan 模式、Skill、MCP tools runtime 和 AgentBench。
- Writer/Reviewer 临时 worktree、受限验证、基线冲突和父级合入。
- 默认终端、`--verbose`、`--trace` 与机器事件流。

## P0：保持可证明性

这是当前唯一持续优先级。

### 小型代表性 AgentBench

维护少量高价值场景，而不是追求数据集规模：

- 只读与修改权限；
- 条件修改和复杂否定；
- Artifact 追问；
- 完整文件审查；
- 测试失败后修复；
- Writer → Reviewer → Parent Merge；
- 父子 Patch 冲突；
- Web 搜索失败和证据不足。

每个场景记录成功条件、禁止能力、工具轨迹和失败分类。

### 真实模型抽样

默认 CI 保持确定性。定期对少数模型执行 opt-in 重复评测，观察：

- run pass rate / pass@k；
- 路由和权限错误；
- 工具选择；
- 平均步骤和重复动作；
- Token、缓存、时延和成本；
- Guardrail 命中与恢复率。

不要用一次成功对话替代指标。

### 文档事实检查

- CLI 命令以 `--help` 为准；
- 当前能力以源码和测试为准；
- 测试数字只在项目现状中维护；
- 历史方案只放入架构演进；
- README 不重新膨胀成功能清单。

## P1：有限的可靠性增强

只有在真实问题再次出现时才实施。

### 语义评测

- 为 TaskUnderstanding 生成释义、否定、条件和中英文对抗样本；
- 统计误授予权限、误拒绝修改和追问谓词丢失；
- 对模型语义补全测量调用率与回退率；
- 不恢复按具体主题编写的问句规则。

### 子 Agent 隔离

- 可选容器/系统沙箱；
- CPU、内存、时间和网络配额；
- 子级依赖安装策略；
- 更明确的语义冲突说明；
- Windows worktree 和命令允许列表验证。

应用层 worktree 已满足当前作品演示；强沙箱属于产品化方向，不是面试项目前置条件。

### Web 声明与来源

- 逐条 claim-source 对齐；
- 来源冲突摘要；
- 软 404、无正文 SPA、订阅墙和地区限制识别；
- 可插拔 Search Provider；
- 垂直 API 作为独立 Tool 接入，而不是继续强化通用搜索 Prompt。

## P2：产品体验

按实际使用频率决定。

### 安装与发布

- 版本化 GitHub Release；
- npm 包发布和安装验证；
- 配置 Profile；
- macOS、Linux、Windows 最小兼容矩阵。

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
