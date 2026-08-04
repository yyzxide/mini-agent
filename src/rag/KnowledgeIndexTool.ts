import { z } from "zod";
import { loadAgentConfig } from "../config/AgentConfig.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import type { Tool, ToolContext, ToolResult } from "../tools/Tool.js";
import { toolFailure, toolSuccess } from "../tools/Tool.js";
import { RagStore } from "./RagStore.js";
import type { RagIngestResult } from "./RagTypes.js";

const KnowledgeIndexInputSchema = z.object({
  paths: z.array(z.string().trim().min(1)).min(1).max(20),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
  chunkSize: z.number().int().min(200).max(8_000).optional(),
  overlap: z.number().int().min(0).max(2_000).optional(),
}).superRefine((input, context) => {
  const chunkSize = input.chunkSize ?? 1_200;
  const overlap = input.overlap ?? 120;
  if (overlap >= chunkSize) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overlap"],
      message: "overlap must be smaller than chunkSize",
    });
  }
});

type KnowledgeIndexInput = z.infer<typeof KnowledgeIndexInputSchema>;

export class KnowledgeIndexTool implements Tool<KnowledgeIndexInput, RagIngestResult> {
  readonly name = "knowledge_index";
  readonly description = "Index selected repository text/source/config paths for later grounded knowledge_search calls.";
  readonly inputSchema = KnowledgeIndexInputSchema;
  readonly permissionLevel = PermissionLevel.REVIEW;
  readonly metadata = {
    category: "knowledge" as const,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };

  async execute(input: KnowledgeIndexInput, context: ToolContext): Promise<ToolResult<RagIngestResult>> {
    const permission = await (context.permissionManager ?? new PermissionManager()).check({
      level: PermissionLevel.REVIEW,
      action: "knowledge_index",
      description: `Build the derived repository knowledge index for: ${input.paths.join(", ")}`,
      ...(context.nonInteractive === undefined ? {} : { nonInteractive: context.nonInteractive }),
      ...(context.autoApprove === undefined ? {} : { autoApprove: context.autoApprove }),
    });
    if (!permission.allowed) {
      return toolFailure("KNOWLEDGE_INDEX_PERMISSION_DENIED", permission.reason ?? "Knowledge index permission denied", { permission });
    }
    const config = await loadAgentConfig(context.repoPath);
    const store = new RagStore({
      repoPath: context.repoPath,
      ...(config.rag?.topK !== undefined ? { defaultTopK: config.rag.topK } : {}),
      ...(config.rag?.minScore !== undefined ? { defaultMinScore: config.rag.minScore } : {}),
      ...(config.rag?.maxContextChars !== undefined ? { defaultMaxContextChars: config.rag.maxContextChars } : {}),
    });
    const result = await store.ingest(input.paths, {
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : {}),
      ...(input.overlap !== undefined ? { overlap: input.overlap } : {}),
    });
    return toolSuccess(result, {
      indexedFiles: result.indexedFiles,
      indexedChunks: result.indexedChunks,
      skippedFiles: result.skipped.length,
      embeddingCache: store.getEmbeddingCacheStats() ?? null,
    });
  }
}
