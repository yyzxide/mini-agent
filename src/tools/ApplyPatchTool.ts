import { z } from "zod";
import { PatchManager } from "../patch/PatchManager.js";
import type { PatchApplyResult, PatchPreviewResult } from "../patch/PatchManager.js";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import {
  errorToCode,
  errorToDetails,
  errorToMessage,
  PatchPermissionDeniedError,
} from "../utils/errors.js";
import { toJsonValue } from "../utils/json.js";
import type { JsonObject } from "../session/SessionTypes.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const ApplyPatchInputSchema = z.object({
  patch: z.string(),
  checkBeforeApply: z.boolean().default(true),
});

export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export interface ApplyPatchData {
  success: boolean;
  applied: boolean;
  preview: PatchPreviewResult;
  diff: string;
  changedFiles: PatchApplyResult["changedFiles"];
  error?: string;
}

export class ApplyPatchTool implements Tool<ApplyPatchInput, ApplyPatchData> {
  readonly name = "apply_patch";
  readonly description = "Preview, check, and apply a unified diff patch.";
  readonly inputSchema = ApplyPatchInputSchema;
  readonly permissionLevel = PermissionLevel.REVIEW;
  readonly metadata = {
    category: "patch" as const,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  };

  async execute(input: ApplyPatchInput, context: ToolContext): Promise<ToolResult<ApplyPatchData>> {
    const patchManager = new PatchManager({ repoPath: context.repoPath });

    try {
      const preview = await patchManager.previewPatch({ patch: input.patch });
      await appendEvent(context, "PATCH_APPLY_STARTED", {
        summary: preview.summary,
        files: toJsonValue(preview.files),
      });

      const permissionManager = context.permissionManager ?? new PermissionManager();
      const permissionInput = {
        level: PermissionLevel.REVIEW,
        action: "apply_patch",
        description: buildPatchDescription(preview),
        ...(context.nonInteractive === undefined ? {} : { nonInteractive: context.nonInteractive }),
        ...(context.autoApprove === undefined ? {} : { autoApprove: context.autoApprove }),
      };
      const permission = await permissionManager.check(permissionInput);

      if (!permission.allowed) {
        const error = new PatchPermissionDeniedError(permission.reason ?? "Patch permission denied", { permission });
        await appendPatchFailure(context, error.message, undefined, permission.reason);
        return toolFailure(error.code, error.message, error.details);
      }

      const applyResult = await patchManager.applyPatch({
        patch: input.patch,
        checkBeforeApply: input.checkBeforeApply,
      });

      if (!applyResult.success) {
        await appendPatchFailure(context, applyResult.error ?? "Patch apply failed", applyResult.checkResult.stderr);
        return toolFailure("PATCH_APPLY_FAILED", applyResult.error ?? "Patch apply failed", applyResult);
      }

      const data: ApplyPatchData = {
        success: true,
        applied: true,
        preview: applyResult.preview,
        diff: applyResult.diff,
        changedFiles: applyResult.changedFiles,
      };

      await appendRecord(context, "FILE_CHANGE", {
        files: toJsonValue(applyResult.changedFiles),
        diff: applyResult.diff,
      });

      await appendEvent(context, "PATCH_APPLY_FINISHED", {
        success: true,
        applied: true,
        changedFiles: toJsonValue(applyResult.changedFiles),
      });

      return toolSuccess(data);
    } catch (error) {
      const message = errorToMessage(error);
      await appendPatchFailure(context, message);
      return toolFailure(errorToCode(error, "PATCH_TOOL_FAILED"), message, errorToDetails(error));
    }
  }
}

function buildPatchDescription(preview: PatchPreviewResult): string {
  const files = preview.files
    .map((file, index) => `${index + 1}. ${file.path} (+${file.additions}, -${file.deletions})`)
    .join("\n");

  return `Agent wants to apply patch:\n\n${preview.summary}\n\n${files}`;
}

async function appendPatchFailure(
  context: ToolContext,
  error: string,
  stderr?: string,
  reason?: string,
): Promise<ToolResult<never> | undefined> {
  return await appendEvent(context, "PATCH_APPLY_FAILED", {
    success: false,
    error,
    stderr: stderr ?? "",
    reason: reason ?? "",
  });
}

async function appendRecord(
  context: ToolContext,
  type: "FILE_CHANGE" | "ERROR",
  payload: JsonObject,
): Promise<ToolResult<never> | undefined> {
  if (!context.sessionId || !context.sessionStore) {
    return undefined;
  }

  try {
    await context.sessionStore.appendRecord(context.sessionId, { type, payload });
    return undefined;
  } catch (error) {
    return toolFailure(errorToCode(error, "SESSION_RECORD_WRITE_FAILED"), errorToMessage(error), errorToDetails(error));
  }
}

async function appendEvent(
  context: ToolContext,
  type: "PATCH_APPLY_STARTED" | "PATCH_APPLY_FINISHED" | "PATCH_APPLY_FAILED",
  payload: JsonObject,
): Promise<ToolResult<never> | undefined> {
  if (!context.sessionId || !context.eventStore) {
    return undefined;
  }

  try {
    await context.eventStore.appendEvent(context.sessionId, { type, payload });
    return undefined;
  } catch (error) {
    return toolFailure(errorToCode(error, "EVENT_WRITE_FAILED"), errorToMessage(error), errorToDetails(error));
  }
}
