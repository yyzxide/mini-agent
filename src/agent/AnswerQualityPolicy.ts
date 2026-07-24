export type AnswerIntent =
  | "DEFINITION"
  | "COUNT"
  | "ENUMERATION"
  | "BOUNDED_RELATION"
  | "IDENTITY"
  | "EXPLANATION"
  | "GENERAL";

export type AnswerDepth = "BRIEF" | "BALANCED" | "DETAILED";

export interface AnswerQualityProfile {
  intent: AnswerIntent;
  depth: AnswerDepth;
  instructions: string[];
}

export interface AnswerQualityViolation {
  code: string;
  message: string;
}

/**
 * Describes what a useful answer must contain independently from how its facts
 * are gathered. Evidence thresholds prove that research happened; this policy
 * prevents the model from treating that minimum as permission to return the
 * shortest possible summary.
 */
export function buildAnswerQualityProfile(
  userGoal: string,
  understanding: TaskUnderstanding = understandTask(userGoal),
): AnswerQualityProfile {
  const depth = understanding.answerDepth;
  const intent = mapAnswerIntent(understanding.answerShape);
  const instructions = [
    "Evidence sufficiency is only a minimum completion condition. Give a complete, useful answer to the current request rather than the shortest summary that passes source checks.",
    depth === "BRIEF"
      ? "The user requested brevity: lead with the direct answer and include only the essential qualification."
      : depth === "DETAILED"
        ? "The user requested detail: explain the conclusion, scope, important distinctions, supporting facts, and uncertainty with readable structure."
        : "Use balanced depth: lead with the direct answer, then add the key scope, distinctions, and supporting details needed to make it useful.",
    ...intentInstructions(intent),
  ];
  return { intent, depth, instructions };
}

export function validateAnswerQuality(
  userGoal: string,
  summary: string,
): AnswerQualityViolation | undefined {
  if (reportsEvidenceLimitation(summary)) return undefined;
  const profile = buildAnswerQualityProfile(userGoal);
  const normalized = normalize(summary);

  if (isSourceOnlyAnswer(normalized)) {
    return {
      code: "FINAL_WITHOUT_SUBSTANTIVE_ANSWER",
      message: "Postcondition failed: the final response points to sources but does not provide a substantive answer. State the conclusion and useful supporting detail before the citations.",
    };
  }

  if (profile.intent === "COUNT") {
    const hasNumericAnswer = /(?:\b\d+(?:[.,]\d+)?\b|[一二三四五六七八九十百千万亿两]+)\s*(?:个|位|家|项|种|部|次|名|所|间|只|条|%|percent|companies|items|people|times)?/i.test(normalized);
    const explicitlyUnstableOrUnknown = /(?:没有|未|无法|不能|难以).{0,16}(?:公开|确认|确定|核实|统计|给出).{0,12}(?:确切|准确|统一|固定)?(?:总数|数量|数字)?|(?:取决于|按照|基于).{0,12}(?:口径|定义|范围|时间)|\b(?:no|not).{0,20}(?:exact|stable|public|confirmed).{0,12}(?:count|number)|\b(?:depends on|varies by).{0,16}(?:scope|definition|date)/i.test(normalized);
    if (!hasNumericAnswer && !explicitlyUnstableOrUnknown) {
      return {
        code: "FINAL_DOES_NOT_ANSWER_COUNT",
        message: "Postcondition failed: the user asked for a count, but the answer provides neither a supported number nor an explicit explanation that no stable count can be established under the available scope.",
      };
    }
    if (
      explicitlyUnstableOrUnknown
      && !/(?:口径|定义|范围|时间点|截至|合并|控股|参股|公开披露|来源)|\b(?:scope|definition|as of|consolidated|controlled|public disclosure|source)\b/i.test(normalized)
    ) {
      return {
        code: "FINAL_COUNT_LIMITATION_WITHOUT_SCOPE",
        message: "Postcondition failed: the answer says an exact count is unavailable but does not explain the relevant definition, scope, time point, or disclosure limitation.",
      };
    }
  }

  if (profile.intent === "ENUMERATION") {
    const hasStructuredItems = /(?:^|\n)\s*(?:[-*]|\d+[.)、])/m.test(summary)
      || (summary.match(/[、,，;]/g)?.length ?? 0) >= 2;
    if (!hasStructuredItems) {
      return {
        code: "FINAL_DOES_NOT_ANSWER_ENUMERATION",
        message: "Postcondition failed: the user requested multiple items, but the answer does not provide a readable list or clearly separated examples.",
      };
    }
  }

  if (profile.intent === "DEFINITION") {
    const hasDefinition = /(?:是指|指的是|是一种|是一个|是由|指\b|意味着|定义为|用于|包括|要求|规定|说明)|\b(?:is a|is an|refers to|means|is defined as|is used for|requires|consists of|specifies)\b/i.test(normalized);
    if (!hasDefinition) {
      return {
        code: "FINAL_DOES_NOT_DEFINE_SUBJECT",
        message: "Postcondition failed: the user asked for a definition, but the response does not directly define the subject.",
      };
    }
  }

  return undefined;
}

function intentInstructions(intent: AnswerIntent): string[] {
  switch (intent) {
    case "DEFINITION":
      return ["Define the subject directly, then give its essential purpose or role and two to four useful characteristics or distinctions unless the user explicitly requested a one-line answer."];
    case "COUNT":
      return ["Answer the requested count directly when the evidence supports one. If no stable exact count exists, explain the definition, scope, time point, or disclosure limitation; do not replace the requested category with related but different categories."];
    case "ENUMERATION":
      return ["Provide a readable list that matches the requested scope. State whether it is complete, representative, or limited by the available evidence."];
    case "BOUNDED_RELATION":
      return ["Lead with the specific bounded answer. If the wording could mean a main/final item or every item in the bounded scope, distinguish those interpretations instead of flattening them into one ambiguous sentence."];
    case "IDENTITY":
      return ["Name the requested entity directly, then briefly state the role and any scope or time qualification needed to avoid ambiguity."];
    case "EXPLANATION":
      return ["Explain the causal or operational chain, not only the conclusion. Use steps or a compact example when that materially improves understanding."];
    case "GENERAL":
      return ["Answer the user's actual question directly and include the key context needed to act on or understand the answer."];
  }
}

function mapAnswerIntent(shape: TaskUnderstanding["answerShape"]): AnswerIntent {
  switch (shape) {
    case "DEFINITION":
    case "COUNT":
    case "ENUMERATION":
    case "IDENTITY":
    case "EXPLANATION":
      return shape;
    case "RELATION":
      return "BOUNDED_RELATION";
    case "FREEFORM":
      return "GENERAL";
  }
}

function isSourceOnlyAnswer(value: string): boolean {
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, " ");
  const withoutLabels = withoutUrls
    .replace(/(?:来源|资料|参考|详见|链接|source|sources|reference|references|see)\s*[:：]?/gi, " ")
    .replace(/[-*#()[\]【】]/g, " ")
    .trim();
  return withoutLabels.length === 0
    || /^(?:已找到|请查看|可参考|详见|见上述|found it|see above|see the link)[。.!！]?$/i.test(withoutLabels);
}

function reportsEvidenceLimitation(value: string): boolean {
  return /(?:证据|来源|资料).{0,10}(?:不足|不充分|无法核验|无法确认)|(?:不足以|无法).{0,16}(?:核验|确认|回答)|\b(?:insufficient|not enough|unable to verify|cannot verify|could not verify)\b/i.test(value);
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
import { understandTask, type TaskUnderstanding } from "./TaskUnderstanding.js";
