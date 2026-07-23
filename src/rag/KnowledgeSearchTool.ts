import { z } from "zod";
import { loadAgentConfig } from "../config/AgentConfig.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "../tools/Tool.js";
import { toolSuccess } from "../tools/Tool.js";
import { RagStore } from "./RagStore.js";
import type { RagSearchResponse } from "./RagTypes.js";

const KnowledgeSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(10).optional(),
  minScore: z.number().min(0).max(1).optional(),
  source: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
});

type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInputSchema>;

export class KnowledgeSearchTool implements Tool<KnowledgeSearchInput, RagSearchResponse> {
  readonly name = "knowledge_search";
  readonly description = "Search the repository-local RAG knowledge base and return grounded passages with line citations.";
  readonly inputSchema = KnowledgeSearchInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;
  readonly metadata = {
    category: "search" as const,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };

  async execute(input: KnowledgeSearchInput, context: ToolContext): Promise<ToolResult<RagSearchResponse>> {
    const config = await loadAgentConfig(context.repoPath);
    const store = new RagStore({
      repoPath: context.repoPath,
      ...(config.rag?.topK !== undefined ? { defaultTopK: config.rag.topK } : {}),
      ...(config.rag?.minScore !== undefined ? { defaultMinScore: config.rag.minScore } : {}),
      ...(config.rag?.maxContextChars !== undefined ? { defaultMaxContextChars: config.rag.maxContextChars } : {}),
    });
    const response = await store.search(input.query, {
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    });
    return toolSuccess(response, {
      found: response.found,
      reason: response.reason ?? null,
      citations: response.citations,
      embeddingCache: store.getEmbeddingCacheStats() ?? null,
    });
  }
}
