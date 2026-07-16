# RAG 使用、设计与评测指南

## 1. 能力边界

当前 RAG 面向仓库内的 Markdown 和纯文本知识文档，不负责 PDF/OCR、网页抓取或多租户知识库。它与长期记忆分开存储：

- `.mini-agent/rag/index.jsonl`：稳定文档知识，按来源增量更新。
- `.mini-agent/memory/index.jsonl`：会话总结和显式记忆，具有 TTL、置信度和替代关系。

准确口径是：项目实现了一个仓库级、可离线运行、可评测的文档 RAG 子系统；它不是面向大规模并发的生产知识库平台。

## 2. 完整链路

```text
Markdown/TXT
-> 仓库路径和文件类型校验
-> 标题提取、文本规范化、source hash
-> 按行分块和 overlap
-> 关键词提取 + embedding
-> JSONL 原子落盘
-> query embedding
-> 来源/标签 metadata filter
-> 向量与关键词混合打分
-> Top-K、来源多样性、上下文预算
-> 带行号 citation 的证据上下文
-> Agent grounded answer 或证据不足拒答
-> 离线数据集评测
```

`src/rag` 的主要职责：

- `DocumentLoader`：只允许读取仓库内 `.md`、`.markdown`、`.txt`，跳过内部目录、符号链接、超大文件和不支持类型。
- `TextChunker`：保留起止行号和 Markdown 标题，支持可配置 chunk size 与 overlap。
- `RagStore`：增量索引、原子写入、混合检索、过滤、证据选择和索引维护。
- `KnowledgeSearchTool`：把检索能力注册为只读 `SAFE` Agent 工具。
- `RagEvaluator`：计算 answerability accuracy、hit rate、Recall@K 和 MRR。

## 3. 使用方式

导入知识文档：

```bash
mini-agent rag ingest docs --tag project
mini-agent rag ingest README.md docs/zh-CN --chunk-size 1200 --overlap 180
```

重复导入未变化的同一文件会跳过。源内容、标签、分块参数或 embedding provider 变化时，会删除该来源旧分块并重建。

查询和过滤：

```bash
mini-agent rag search "MCP 工具权限如何映射"
mini-agent rag search "RAG 如何拒答" --top-k 3 --tag project
mini-agent rag search "会话恢复" --source docs/zh-CN
```

维护索引：

```bash
mini-agent rag stats
mini-agent rag remove docs/obsolete.md
mini-agent rag clear
```

Agent 可通过统一工具执行：

```bash
mini-agent tool run knowledge_search '{"query":"RAG 的评测指标是什么","topK":3}'
```

返回结果包含 `context`、`citations` 和逐条 `score`。引用格式为 `path#Lx-Ly`。如果查询为空、索引为空、embedding provider 不匹配或相关度不足，结果会返回 `found: false` 和明确 `reason`，而不是生成看似合理的答案。

## 4. Embedding 配置

未配置远端 embedding 时使用 `local-hash-v2`，适合离线演示和确定性测试，但语义能力有限。为降低哈希碰撞导致的假阳性，离线 provider 对长查询要求至少命中两个有效词项并达到最低覆盖率；真实 embedding provider 可以进行纯语义召回。配置以下环境变量后使用 OpenAI-compatible `/embeddings`：

```text
MINI_AGENT_EMBEDDING_BASE_URL
MINI_AGENT_EMBEDDING_API_KEY
MINI_AGENT_EMBEDDING_MODEL
```

索引记录 embedding provider id；远端 provider id 同时包含模型和服务端点的不可逆摘要。切换 provider 后旧向量不会参与检索，查询会返回 `EMBEDDING_PROVIDER_MISMATCH`；需要重新执行 `rag ingest`。这样可以避免不同维度或不同向量空间被错误混算。

## 5. 缓存职责与实现

缓存命中不是模型应该自行决定的动作，而是 Agent 基础设施和模型服务商各自负责的机制：

- LLM 的 KV/Prompt Cache 由模型服务端维护。CLI 尽量保持稳定提示前缀，并记录服务端返回的 `cached_tokens`，但不会伪造通用的客户端读写协议。
- 远端 embedding 结果由 Agent 缓存到 `.mini-agent/cache/embeddings/v1/`。缓存键包含 schema 版本、embedding provider/vector-space id 和原文 SHA-256；缓存文件只保存向量及必要元数据，不保存原文。
- 同一进程内还有有界 LRU 和 single-flight，相同并发请求只会回源一次。磁盘项损坏、向量非法、provider 不一致或维度不一致都会按 miss 处理，不会拿错误向量继续计算。
- `.mini-agent/rag/index.jsonl` 是可重建的文档派生索引，`.mini-agent/memory/index.jsonl` 是受治理的历史记忆数据；二者不能笼统地称为“缓存”。删除手工记忆会丢失业务数据，而清理 embedding cache 只会让后续请求重新计算。

完整 LLM 回答和 `AgentDecision` 默认不缓存，因为它们依赖会话、仓库状态、时间和副作用；直接重放可能陈旧或不安全。

## 6. 评测数据集

数据集使用 JSON 数组或 `{ "cases": [...] }`：

```json
{
  "cases": [
    {
      "id": "mcp-permission",
      "query": "MCP 远程工具怎样进入权限体系？",
      "relevantSources": ["docs/zh-CN/ARCHITECTURE.md"],
      "topK": 5
    },
    {
      "id": "unknown-policy",
      "query": "公司明年的销售目标是多少？",
      "expectNoAnswer": true
    }
  ]
}
```

运行：

```bash
mini-agent rag eval docs/rag-eval.example.json
```

指标含义：

- `answerabilityAccuracy`：该回答时找到证据、该拒答时没有误召回的比例。
- `hitRate`：可回答问题的 Top-K 中是否至少命中一个相关来源。
- `meanRecallAtK`：Top-K 覆盖相关来源的平均比例。
- `meanReciprocalRank`：第一个相关来源排名倒数的平均值，越接近 1 越好。

## 7. 安全与局限

- 文档内容是不可信数据，不能因为文档写着“忽略系统指令”就改变 Agent 行为。
- 路径校验只能保证不读取仓库外和内部元数据，不能证明文档事实本身正确。
- RAG 降低无依据生成风险，但不能消灭幻觉；最终回答仍应只使用返回证据并保留 citation。
- JSONL 适合单机项目和演示，不适合多进程并发写、大规模向量检索或租户隔离。
- 当前没有 cross-encoder reranker、查询改写、PDF/OCR、表格结构解析、增量文件监听和 claim-source 自动核验。

生产化时优先考虑批量 embedding、SQLite/pgvector/LanceDB/Qdrant、索引版本迁移、并发锁、文档 ACL、观测指标和更完整的离线/在线评测。
