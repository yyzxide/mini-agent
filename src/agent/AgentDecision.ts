import { z } from "zod";

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
}).strict();

export const ApplyPatchDecisionSchema = z.object({
  type: z.literal("APPLY_PATCH"),
  patch: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const RunCommandDecisionSchema = z.object({
  type: z.literal("RUN_COMMAND"),
  command: z.string().min(1),
  description: z.string().min(1),
}).strict();

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
  ApplyPatchDecisionSchema,
  RunCommandDecisionSchema,
  AskUserDecisionSchema,
  FinalDecisionSchema,
  FailedDecisionSchema,
]);

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
export type ToolCallDecision = z.infer<typeof ToolCallDecisionSchema>;
export type ApplyPatchDecision = z.infer<typeof ApplyPatchDecisionSchema>;
export type RunCommandDecision = z.infer<typeof RunCommandDecisionSchema>;
export type AskUserDecision = z.infer<typeof AskUserDecisionSchema>;
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;
export type FailedDecision = z.infer<typeof FailedDecisionSchema>;
