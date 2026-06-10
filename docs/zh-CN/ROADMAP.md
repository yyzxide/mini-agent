# 后续规划

## 1. 短期：把 MVP 打磨得更稳

### 1.1 更强的真实模型协议

当前已经有 OpenAI-compatible client 和结构化 decision 解析。下一步可以：

- 使用严格 JSON schema。
- 为每类 decision 增加 few-shot 示例。
- 对格式错误做一次自动修复 retry。
- 把工具列表和权限信息动态注入 prompt。
- 对 final 输出增加固定字段：summary、tests、diffSummary、risks。

### 1.2 更完整的失败修复循环

目标是让测试失败后最多自动修 3 轮：

1. 命令失败结果进入上下文。
2. 提取关键 stderr/stdout。
3. 搜索相关文件。
4. 生成最小 patch。
5. 重新运行同一测试命令。
6. 仍失败则输出失败原因和当前 diff。

可以新增：

- `TestFailureAnalyzer`
- `CommandErrorSummarizer`
- `RepairAttemptState`

### 1.3 工具增强

可新增工具：

- `write_file_preview`：生成文件替换预览，但仍通过 patch 应用。
- `list_symbols`：基于语言服务或 tree-sitter 提取符号。
- `find_tests`：按文件或符号定位测试。
- `package_scripts`：读取 package.json scripts、pom.xml goals 等。
- `dependency_summary`：总结主要依赖。

## 2. 中期：让沙箱和控制面更接近生产

### 2.1 Docker 沙箱加固

可做：

- 非 root 用户运行。
- `--read-only` 根文件系统。
- 单独 tmpfs。
- drop capabilities。
- seccomp/AppArmor profile。
- 限制进程数。
- 更细资源配额。
- 网络 allowlist，而不是简单开关。

### 2.2 Secret 管理

当前真实模型环境变量不会写入数据库命令日志，但还可以继续加强：

- 后端统一 redaction。
- 前端避免展示敏感 env。
- API key 只从服务端安全配置读取。
- Docker 任务使用临时 env 注入。
- session/event 输出脱敏。

### 2.3 任务队列

当前后端适合本地单机演示。中期可以加：

- 队列和并发限制。
- 任务优先级。
- 任务超时和重试。
- Runner worker 池。
- 更明确的取消语义。

## 3. 中期：提升 Web 体验

### 3.1 Diff 交互

- 文件级 diff 折叠。
- 行级高亮。
- patch 摘要。
- 一键复制 diff。
- 显示修改文件列表。

### 3.2 事件时间线

- 按 tool/command/patch 分类筛选。
- 展示 duration。
- 失败事件聚合。
- 关联 session record。

### 3.3 任务创建体验

- 记住最近 repoPath。
- 校验 repoPath 是否可访问。
- 自动识别项目类型。
- 推荐测试命令。
- 预设 execution mode。

## 4. 中期：GitHub/GitLab PR

在现有 Git Workflow 上扩展：

```text
branch -> commit -> push -> create PR/MR -> update workflow URL
```

需要新增：

- `GitRemoteProvider` 接口。
- GitHub/GitLab token 配置。
- remote branch 命名策略。
- PR label/reviewer/assignee 配置。
- PR 创建失败的重试和回滚策略。

## 5. 长期：多用户和平台化

如果要从本地工具变成团队平台：

- 用户登录和权限。
- workspace/project 管理。
- 模型配置按项目隔离。
- 任务成本统计。
- 审计日志。
- 组织级 policy。
- 集中式数据库。
- 对象存储保存 session、diff 和日志。
- Runner 节点横向扩展。

## 6. 长期：智能能力

### 6.1 上下文系统

- 文件重要性排序。
- 历史编辑摘要。
- 最近失败优先。
- build/test 文件优先。
- 符号图谱。
- 向量检索作为补充，而不是唯一入口。

### 6.2 代码理解

- tree-sitter AST。
- TypeScript/Java 语言服务。
- 调用链分析。
- 测试覆盖映射。
- 变更影响分析。

### 6.3 评审能力

- 自动生成 review checklist。
- 检测高风险 diff。
- 检测未更新测试。
- 检测 API 兼容性风险。
- 输出 reviewer notes。

## 7. 推荐下一步优先级

如果继续开发，推荐顺序：

1. 加强真实模型 JSON 协议和错误重试。
2. 完成测试失败三轮修复闭环。
3. 前端 diff 文件列表和事件 duration。
4. Docker 非 root 和 read-only rootfs。
5. GitHub PR 创建。

这个顺序的原因是：先提高 Agent 真实任务成功率，再增强演示体验，然后逐步补安全和交付能力。

