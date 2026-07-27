# Plan 模式

Plan 模式用于“先调查和制定方案，暂不产生副作用”。它不是一条只靠 Prompt 提醒模型别写文件的分支，而是覆盖当前任务契约，并在工具暴露和运行时执行两层阻断写操作。

## 进入方式

一次性规划：

```bash
mini-agent plan "描述你的任务"
```

交互模式：

```text
> /plan
> /plan 为项目增加一个新工具
```

带任务的 `/plan` 会立即执行一次规划；不带任务时只切换当前 Session 的 Operating Mode。

## 能做什么

Plan 模式可以：

- 读取仓库；
- 搜索代码；
- 根据原任务使用允许的只读证据工具；
- 分析依赖与风险；
- 输出可执行的步骤和验证方案。

Plan 模式不能：

- `APPLY_PATCH`；
- `APPLY_DELEGATED_PATCH`；
- `RUN_COMMAND`；
- 伪装成 Tool Call 的写工具；
- 通过 Skill、MCP 或子 Agent 绕过只读边界。

计划任务即使描述了未来代码修改，也不要求当前已经产生 Patch。

## 退出和执行

在交互模式中：

```text
> /plan off
> /execute
```

`/plan off` 退出只读模式但保留当前 Session 最近一份成功计划。`/execute` 把该计划作为执行上下文重新进入正常 Task Contract；它不是重放 Plan 阶段的工具调用。

也可以退出 Plan 后输入新的自然语言任务，不执行旧计划。

## Session 与恢复

Operating Mode 和最近成功计划随 Session 保存。恢复 Session 后，系统不会因为旧计划存在就自动写文件，仍然需要显式 `/execute` 或新的执行请求。

## 示例

```text
$ mini-agent
> /plan 为项目增加 TypeScript 类型定义
[plan] 1. 检查当前导出边界
[plan] 2. 找到需要声明的公共类型
[plan] 3. 设计文件位置和兼容策略
[plan] 4. 规划 typecheck 与回归测试
> /plan off
> /execute
```

验证 Plan 模式时，应同时检查工作区未变化、模型不可见写工具、运行时对伪造写 Decision 的拒绝事件。
