# Roadmap

当前路线：先把本地 CLI Coding Agent 打磨扎实，再考虑外部集成。

## 1. 近期：让 CLI 更可靠

### 1.1 Prompt 和 DecisionParser

- 强化工具调用格式约束。
- 增加模型输出自修复逻辑。
- 对非法 JSON、未知 decision、缺字段提供更清楚的错误。

### 1.2 上下文质量

- 更好地摘要 README、构建文件和目录树。
- 最近工具结果按重要性截断。
- 命令失败日志保留关键片段。
- git diff 摘要区分新增、删除、修改文件。

### 1.3 测试命令识别

- Node 项目识别 `npm test`、`pnpm test`、`vitest`。
- Java 项目识别 `mvn test`、`gradle test`。
- Go 项目识别 `go test ./...`。
- Python 项目识别 `pytest`。

## 2. 中期：提升开发体验

### 2.1 Dry-run 模式

新增：

```bash
mini-agent run "..." --dry-run
```

只展示计划、工具调用和 patch 预览，不真正落盘或执行危险命令。

### 2.2 Session Replay

支持：

```bash
mini-agent session replay <sessionId>
```

按时间线重放工具调用、命令结果和最终 diff，方便复盘和面试演示。

### 2.3 更好的终端输出

- 分组展示 plan、tool、patch、command、result。
- 对长输出折叠。
- 对 diff 做文件级摘要。
- 对错误给出下一步建议。

## 3. 安全增强

- 更细粒度的命令白名单/黑名单。
- patch 修改文件数量和单文件大小限制。
- 工作树脏状态提醒。
- API key redaction 覆盖所有日志和错误。
- 可选只读扫描模式。

## 4. 外部集成

保持 CLI 为核心，只提供轻量集成点：

- `--event-stream` 给其他系统读取事件。
- session/event JSONL 作为稳定数据格式。
- 可选导出 Markdown 报告。
- 可选生成 commit message 和 PR description 草稿。

## 5. 暂不做

当前不在本仓库内做：

- 业务后台。
- Web 控制台。
- 多用户管理。
- 远程 PR 自动创建。
- 生产级沙箱。

这些可以以后作为独立项目或插件实现。
