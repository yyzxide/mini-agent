import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "../tools/Tool.js";
import { toolSuccess } from "../tools/Tool.js";
import { SkillStore, type SkillReadResult } from "./SkillStore.js";

const SkillReadInputSchema = z.object({
  name: z.string().trim().min(1),
  resource: z.string().trim().min(1).optional(),
  startLine: z.number().int().positive().default(1),
  maxLines: z.number().int().positive().max(500).default(200),
});

type SkillReadInput = z.infer<typeof SkillReadInputSchema>;

export class SkillReadTool implements Tool<SkillReadInput, SkillReadResult> {
  readonly name = "skill_read";
  readonly description = "Read complete instructions or a bundled text resource from a discovered repository/local skill.";
  readonly inputSchema = SkillReadInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;
  readonly metadata = {
    category: "skill" as const,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };

  async execute(input: SkillReadInput, context: ToolContext): Promise<ToolResult<SkillReadResult>> {
    const result = await new SkillStore({ repoPath: context.repoPath }).read(input.name, {
      ...(input.resource ? { resource: input.resource } : {}),
      startLine: input.startLine,
      maxLines: input.maxLines,
    });
    return toolSuccess(result, { skill: result.name, resource: result.resource, complete: !result.hasMore });
  }
}
