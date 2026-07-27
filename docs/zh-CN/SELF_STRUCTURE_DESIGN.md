# 早期对话模型自述与当前修正

> 历史说明：这个文件最初由一次对话生成，用“系统提示就是大脑、Router 决定聊天或工具路径”的方式解释项目。该描述对应早期多路径架构，不能作为当前运行时文档。当前规范见[架构设计](ARCHITECTURE.md)，完整迁移过程见[架构演进](ARCHITECTURE_EVOLUTION.md)。

保留这个文件是为了记录项目如何从模型自述式理解，转向可验证的本地控制平面。

## 早期认识

早期解释大致是：

```text
用户
  -> Router
     -> 纯聊天路径：System Prompt 禁止工具和写入
     -> 工具路径：模型输出 AgentDecision
```

当时把以下内容看作主要控制方式：

- System Prompt 定义人格和行为禁区；
- Router 根据关键词决定“聊天”或“操作”；
- 纯聊天路径不能调用工具；
- Skill 通过 Markdown 注入更多指令；
- 历史摘要作为长期记忆进入上下文。

这套解释对入门有帮助，但存在三个问题：

1. 它把 Prompt 约束误认为可靠权限边界；
2. 它暗示不同任务使用不同执行器；
3. 它容易让模型根据当轮工具缺失，错误宣称产品“没有写文件或联网能力”。

## 当前结构

当前项目使用：

```text
用户请求
  -> Follow-up Resolver
  -> TaskUnderstanding
  -> TaskRouter 兼容标签
  -> AgentTaskContract
  -> AgentLoop
     -> ContextBuilder
     -> LLM AgentDecision
     -> 本地 Guardrail
     -> Tool / Patch / Command / Delegate
  -> Session / Event / Checkpoint / Diff
```

### System Prompt 的角色

Prompt 用于告诉模型：

- 当前任务目标；
- 可见工具；
- Task Contract 指令；
- 输出 Schema；
- Context 与证据；
- 如何选择下一步。

Prompt 不是最终权限边界。即使模型违反指令，本地执行层仍会校验 Decision、能力、参数和完成条件。

### TaskUnderstanding 的角色

语义控制面记录：

- operation；
- target；
- answer shape/depth；
- external fact policy；
- explicit Web/repository/mutation；
- complete-file requirement；
- confidence 和 signals。

简单请求确定性处理，复杂组合语义可请求 Schema 约束的模型补全，再由本地安全策略合并。

### Task Contract 的角色

Task Contract 决定这一轮实际获得：

- repository read/write；
- command execution；
- Web、Knowledge、MCP；
- delegation；
- evidence threshold；
- output contract；
- max steps。

因此，“本轮没有 Web 工具”不等于“产品没有 Web 能力”，“当前只读”也不等于“产品不能写文件”。

### Skill 的角色

Skill 仍然是声明式工作流说明，但只能指导已经被 Task Contract 允许的工具。Skill 不能增加权限，也不能覆盖用户要求和仓库事实。

### Memory 的角色

当前区分：

- Conversation；
- Session Context；
- Long-term Memory；
- RAG；
- Prompt Cache；
- Embedding Cache。

历史内容被视为可能过期的上下文证据，不能覆盖当前用户输入或仓库事实。

## 从 A 到 B 的核心变化

| 早期表述 | 当前实现 |
| --- | --- |
| Prompt 是主要行为边界 | Prompt 指导模型，本地契约和执行层负责权限 |
| Router 选择聊天或工具执行器 | 所有任务进入 AgentLoop，Router 只映射兼容标签 |
| 模型根据可见工具自述产品能力 | Capability Registry 提供产品事实 |
| 长期记忆是历史摘要注入 | Memory 有类型、范围、证据、TTL、读取/写入策略 |
| 工具路径负责写文件 | 写入必须通过契约、Patch、验证和完成性门禁 |
| 子代理只读或只生成 Patch | Writer 使用隔离 worktree 修改和验证 |

## 为什么保留这份历史文件

项目文档不应把旧方案直接删除得仿佛从未存在。更有价值的记录方式是：

- 简短保留旧认识；
- 明确它为什么不够；
- 指向当前抽象；
- 说明哪些边界仍未解决。

这个文件只承担历史学习作用，不再参与当前架构说明。
