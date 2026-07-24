import { z } from "zod";
import { SUBAGENT_ROLES } from "./SubAgentTypes.js";

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  JsonObjectSchema,
]));

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

export const PlanDecisionSchema = z.object({
  type: z.literal("PLAN"),
  message: z.string().min(1),
}).strict();

export const ToolCallDecisionSchema = z.object({
  type: z.literal("TOOL_CALL"),
  toolName: z.string().min(1),
  input: JsonObjectSchema.default({}),
  reason: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const SubAgentTaskSchema = z.object({
  id: z.string().trim().min(1).max(48).regex(/^[a-zA-Z0-9_-]+$/),
  role: z.enum(SUBAGENT_ROLES),
  objective: z.string().trim().min(1).max(1_000),
  focusPaths: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  access: z.enum(["READ_ONLY", "PROPOSE_CHANGES", "REVIEW_CHANGES"]).default("READ_ONLY"),
  dependsOn: z.array(z.string().trim().min(1).max(48).regex(/^[a-zA-Z0-9_-]+$/)).max(2).default([]),
}).strict();

export const DelegateDecisionSchema = z.object({
  type: z.literal("DELEGATE"),
  reason: z.string().trim().min(1).max(1_000),
  tasks: z.array(SubAgentTaskSchema).min(1).max(3),
}).strict().superRefine((value, context) => {
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "DELEGATE task ids must be unique",
    });
  }
  const idSet = new Set(ids);
  value.tasks.forEach((task, taskIndex) => {
    if (task.dependsOn.includes(task.id) || task.dependsOn.some((id) => !idSet.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["tasks", taskIndex, "dependsOn"],
        message: "DELEGATE dependencies must reference other task ids in the same batch",
      });
    }
    if (task.access === "PROPOSE_CHANGES" && task.role !== "implementation_agent") {
      context.addIssue({
        code: "custom",
        path: ["tasks", taskIndex, "role"],
        message: "PROPOSE_CHANGES tasks must use the implementation_agent role",
      });
    }
    if (task.access === "REVIEW_CHANGES" && task.dependsOn.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["tasks", taskIndex, "dependsOn"],
        message: "REVIEW_CHANGES tasks must depend on a proposed-change task",
      });
    }
  });
});

/** @deprecated Persisted sessions may still contain the pre-v2 read-only decision. */
export const DelegateReadonlyDecisionSchema = z.object({
  type: z.literal("DELEGATE_READONLY"),
  reason: z.string().trim().min(1).max(1_000),
  tasks: z.array(SubAgentTaskSchema).min(2).max(3),
}).strict().superRefine((value, context) => {
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "DELEGATE_READONLY task ids must be unique",
    });
  }
});

export const ApplyDelegatedPatchDecisionSchema = z.object({
  type: z.literal("APPLY_DELEGATED_PATCH"),
  taskId: z.string().trim().min(1).max(48),
  description: z.string().trim().min(1).max(1_000),
}).strict();

export const ApplyPatchDecisionSchema = z.object({
  type: z.literal("APPLY_PATCH"),
  patch: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const RunCommandDecisionSchema = z.object({
  type: z.literal("RUN_COMMAND"),
  executable: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  command: z.string().min(1).optional(),
  shell: z.boolean().default(false),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.shell) {
    if (!value.command) {
      context.addIssue({
        code: "custom",
        message: "RUN_COMMAND shell decisions require command",
        path: ["command"],
      });
    }
    return;
  }

  if (!value.executable) {
    context.addIssue({
      code: "custom",
      message: "RUN_COMMAND decisions require executable when shell is false",
      path: ["executable"],
    });
  }

  if (value.command) {
    context.addIssue({
      code: "custom",
      message: "RUN_COMMAND command is only allowed when shell is true",
      path: ["command"],
    });
  }
});

export const AskUserDecisionSchema = z.object({
  type: z.literal("ASK_USER"),
  message: z.string().min(1),
}).strict();

export const FinalDecisionSchema = z.object({
  type: z.literal("FINAL"),
  summary: z.string().min(1),
  success: z.boolean(),
}).strict();

export const FailedDecisionSchema = z.object({
  type: z.literal("FAILED"),
  error: z.string().min(1),
}).strict();

export const AgentDecisionSchema = z.discriminatedUnion("type", [
  PlanDecisionSchema,
  ToolCallDecisionSchema,
  DelegateDecisionSchema,
  DelegateReadonlyDecisionSchema,
  ApplyDelegatedPatchDecisionSchema,
  ApplyPatchDecisionSchema,
  RunCommandDecisionSchema,
  AskUserDecisionSchema,
  FinalDecisionSchema,
  FailedDecisionSchema,
]);

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
export type ToolCallDecision = z.infer<typeof ToolCallDecisionSchema>;
export type DelegateDecision = z.infer<typeof DelegateDecisionSchema>;
export type DelegateReadonlyDecision = z.infer<typeof DelegateReadonlyDecisionSchema>;
export type ApplyDelegatedPatchDecision = z.infer<typeof ApplyDelegatedPatchDecisionSchema>;
export type ApplyPatchDecision = z.infer<typeof ApplyPatchDecisionSchema>;
export type RunCommandDecision = z.infer<typeof RunCommandDecisionSchema>;
export type AskUserDecision = z.infer<typeof AskUserDecisionSchema>;
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;
export type FailedDecision = z.infer<typeof FailedDecisionSchema>;
