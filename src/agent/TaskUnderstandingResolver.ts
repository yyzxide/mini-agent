import { z } from "zod";
import type { LlmClient, LlmTextCompletionResult } from "../llm/LlmClient.js";
import type { ConversationMessage } from "../session/ConversationHistory.js";
import type { ExternalFactPolicy } from "./ExternalFactPolicy.js";
import {
  understandTask,
  type TaskAnswerShape,
  type TaskOperation,
  type TaskTarget,
  type TaskUnderstanding,
} from "./TaskUnderstanding.js";

const CandidateSchema = z.object({
  operation: z.enum([
    "ANSWER",
    "RESEARCH",
    "REVIEW_REPOSITORY",
    "ANALYZE_REPOSITORY",
    "CHANGE_REPOSITORY",
    "QUERY_KNOWLEDGE",
    "LOCAL_STATE",
  ]),
  target: z.enum(["WORLD", "REPOSITORY", "PRODUCT", "SESSION", "DERIVATION"]),
  answerShape: z.enum([
    "DEFINITION",
    "COUNT",
    "ENUMERATION",
    "RELATION",
    "IDENTITY",
    "EXPLANATION",
    "FREEFORM",
  ]),
  answerDepth: z.enum(["BRIEF", "BALANCED", "DETAILED"]),
  externalFactPolicy: z.enum(["GENERAL_KNOWLEDGE", "VERIFICATION_REQUIRED", "NOT_EXTERNAL_FACT"]),
  explicitWeb: z.boolean(),
  explicitRepositoryTarget: z.boolean(),
  explicitMutation: z.boolean(),
  completeFileRead: z.boolean(),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
  rationale: z.string().trim().min(1).max(500),
}).strict();

export interface ResolvedTaskUnderstanding {
  understanding: TaskUnderstanding;
  source: "DETERMINISTIC" | "MODEL_REFINED" | "MODEL_FALLBACK";
  reason: string;
}

export async function resolveTaskUnderstanding(input: {
  userGoal: string;
  llmClient: LlmClient;
  conversation?: ConversationMessage[];
  deterministic?: TaskUnderstanding;
}): Promise<ResolvedTaskUnderstanding> {
  const deterministic = input.deterministic ?? understandTask(input.userGoal);
  if (!shouldUseSemanticRefinement(input.userGoal, deterministic)) {
    return {
      understanding: deterministic,
      source: "DETERMINISTIC",
      reason: "Deterministic interpretation is high-confidence and structurally simple.",
    };
  }
  if (!input.llmClient.completeText) {
    return {
      understanding: deterministic,
      source: "MODEL_FALLBACK",
      reason: "Configured LLM client does not support semantic text completion.",
    };
  }

  const result = await input.llmClient.completeText({
    userGoal: input.userGoal,
    mode: "task_understanding",
    context: buildResolverContext(deterministic, input.conversation),
  });
  const candidate = parseCandidate(result);
  if (!candidate || candidate.confidence < 0.72) {
    return {
      understanding: deterministic,
      source: "MODEL_FALLBACK",
      reason: result.error ?? "Model semantic proposal was invalid or below the confidence threshold.",
    };
  }

  const merged = mergeWithSafetyPolicy(input.userGoal, deterministic, candidate);
  return {
    understanding: merged,
    source: "MODEL_REFINED",
    reason: candidate.rationale,
  };
}

export function shouldUseSemanticRefinement(
  userGoal: string,
  deterministic = understandTask(userGoal),
): boolean {
  if (deterministic.signals.some((signal) => [
    "product-meta",
    "file-change-state",
    "indexed-knowledge",
    "explicit-delegation",
  ].includes(signal))) {
    return false;
  }
  if (deterministic.operation === "LOCAL_STATE") return false;
  const text = userGoal.normalize("NFKC").trim().toLowerCase();
  const compoundOrConditional = /(?:如果|否则|除非|先.+再|然后|但是|不过|不是.+而是|只在.+时)|\b(?:if|otherwise|unless|then|but|only if|rather than)\b/i.test(text);
  const indirectAction = /(?:处理一下|搞一下|按.{0,16}(?:方案|方式).{0,6}(?:来|做)|就这么办|照这个做|你看着办|不太对.{0,12}(?:处理|解决))|\b(?:handle it|take care of it|go with that|do that|fix it if needed)\b/i.test(text);
  const complexNegation = /(?:不要|别|无需|不需要|不能|禁止).{0,30}(?:修改|写|联网|执行|命令|测试)|(?:不是|并非|不只是|不仅仅是).{0,24}(?:只|仅)?.{0,12}(?:分析|解释|建议)|\b(?:do not|don't|without|never)\b.{0,30}\b(?:edit|write|search|web|run|command|test)\b|\b(?:not|isn't|is not)\b.{0,20}\b(?:just|only)\b.{0,12}\b(?:analy[sz]e|explain|advise)\b/i.test(text);
  return compoundOrConditional
    || indirectAction
    || complexNegation;
}

function mergeWithSafetyPolicy(
  userGoal: string,
  deterministic: TaskUnderstanding,
  candidate: z.infer<typeof CandidateSchema>,
): TaskUnderstanding {
  const explicitReadOnly = hasExplicitReadOnlyConstraint(userGoal);
  const hardLocalState = deterministic.operation === "LOCAL_STATE"
    && (deterministic.target === "PRODUCT" || deterministic.target === "SESSION");
  // Preserve an explicit request to use the Web. A deterministic
  // VERIFICATION_REQUIRED label is intentionally not immutable: ambiguous
  // words such as “问题” can otherwise turn a repository request into Web
  // research before the semantic layer has a chance to correct it.
  const hardResearch = deterministic.operation === "RESEARCH"
    && deterministic.explicitWeb;
  const hardMutation = deterministic.operation === "CHANGE_REPOSITORY" && deterministic.explicitMutation;

  let operation: TaskOperation = candidate.operation;
  let target: TaskTarget = candidate.target;
  if (explicitReadOnly && operation === "CHANGE_REPOSITORY") {
    operation = candidate.target === "REPOSITORY" ? "ANALYZE_REPOSITORY" : "ANSWER";
    target = candidate.target === "REPOSITORY" ? "REPOSITORY" : "DERIVATION";
  } else if (hardLocalState) {
    operation = deterministic.operation;
    target = deterministic.target;
  } else if (hardResearch) {
    operation = "RESEARCH";
    target = "WORLD";
  } else if (hardMutation) {
    operation = "CHANGE_REPOSITORY";
    target = "REPOSITORY";
  }

  // A model label alone must never grant repository mutation. The semantic
  // proposal must also explicitly assert that the user requested a mutation.
  if (
    operation === "CHANGE_REPOSITORY"
    && !hardMutation
    && !candidate.explicitMutation
  ) {
    operation = target === "REPOSITORY" || candidate.explicitRepositoryTarget
      ? "ANALYZE_REPOSITORY"
      : "ANSWER";
    target = operation === "ANALYZE_REPOSITORY" ? "REPOSITORY" : "DERIVATION";
  }

  if (["REVIEW_REPOSITORY", "ANALYZE_REPOSITORY", "CHANGE_REPOSITORY", "QUERY_KNOWLEDGE"].includes(operation)) {
    target = "REPOSITORY";
  }
  if (operation === "RESEARCH") target = "WORLD";

  const externalFactPolicy = strongestExternalPolicy(
    deterministic.externalFactPolicy,
    candidate.externalFactPolicy,
    operation,
  );
  const explicitMutation = operation === "CHANGE_REPOSITORY"
    && !explicitReadOnly
    && (deterministic.explicitMutation || candidate.explicitMutation);

  return {
    operation,
    target,
    answerShape: candidate.answerShape as TaskAnswerShape,
    answerDepth: candidate.answerDepth,
    externalFactPolicy,
    explicitWeb: deterministic.explicitWeb || (operation === "RESEARCH" && candidate.explicitWeb),
    explicitRepositoryTarget: deterministic.explicitRepositoryTarget
      || candidate.explicitRepositoryTarget
      || target === "REPOSITORY",
    explicitMutation,
    completeFileRead: deterministic.completeFileRead || candidate.completeFileRead,
    confidence: Math.min(0.99, Math.max(deterministic.confidence, candidate.confidence)),
    signals: [
      ...new Set([
        ...deterministic.signals,
        "model-semantic-refinement",
        ...candidate.ambiguities.map((ambiguity) => `ambiguity:${ambiguity}`),
      ]),
    ],
  };
}

function hasExplicitReadOnlyConstraint(userGoal: string): boolean {
  const explicitConstraint = /(?:不要|别|无需|不需要|禁止).{0,24}(?:修改|改动|写入|写文件)|(?:只|仅).{0,12}(?:分析|解释|建议|代码片段)|\b(?:do not|don't|without|never)\b.{0,24}\b(?:edit|modify|write|change files?)\b|\b(?:analysis|advice|snippet)\s+only\b/i.test(userGoal);
  if (!explicitConstraint) return false;

  const negatesReadOnlyConstraint = /(?:不是|并非|不只是|不仅仅是).{0,12}(?:让你|要你)?(?:只|仅)?.{0,8}(?:分析|解释|建议|给代码片段)|\b(?:not|isn't|is not)\b.{0,16}\b(?:just|only)\b.{0,10}\b(?:analy[sz]e|explain|advise|give a snippet)\b/i.test(userGoal);
  return !negatesReadOnlyConstraint;
}

function strongestExternalPolicy(
  deterministic: ExternalFactPolicy,
  candidate: ExternalFactPolicy,
  operation: TaskOperation,
): ExternalFactPolicy {
  if (operation !== "ANSWER" && operation !== "RESEARCH") return "NOT_EXTERNAL_FACT";
  if (deterministic === "VERIFICATION_REQUIRED" || candidate === "VERIFICATION_REQUIRED" || operation === "RESEARCH") {
    return "VERIFICATION_REQUIRED";
  }
  if (deterministic === "GENERAL_KNOWLEDGE" || candidate === "GENERAL_KNOWLEDGE") {
    return "GENERAL_KNOWLEDGE";
  }
  return "NOT_EXTERNAL_FACT";
}

function parseCandidate(result: LlmTextCompletionResult): z.infer<typeof CandidateSchema> | undefined {
  if (!result.success || !result.text) return undefined;
  try {
    const parsed = JSON.parse(extractJsonObject(result.text)) as unknown;
    const validated = CandidateSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object");
  return value.slice(start, end + 1);
}

function buildResolverContext(
  deterministic: TaskUnderstanding,
  conversation: ConversationMessage[] | undefined,
): string {
  return [
    `Deterministic interpretation:\n${JSON.stringify(deterministic)}`,
    conversation?.length
      ? `Recent conversation:\n${conversation.slice(-6).map((message) => `[${message.role}] ${message.content}`).join("\n")}`
      : "Recent conversation: (none)",
  ].join("\n\n");
}
