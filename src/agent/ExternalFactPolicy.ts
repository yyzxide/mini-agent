import {
  classifyProductMetaIntent,
  looksLikeExplicitWebAction,
} from "./ProductCapability.js";

export type ExternalFactPolicy =
  | "GENERAL_KNOWLEDGE"
  | "VERIFICATION_REQUIRED"
  | "NOT_EXTERNAL_FACT";

export interface ExternalFactPolicyDecision {
  policy: ExternalFactPolicy;
  confidence: number;
  signals: string[];
  reason: string;
}

/**
 * Classifies the evidence requirement of a request independently from its
 * subject matter. Exact, exhaustive, volatile, or explicitly fact-checked
 * claims require external evidence; broad explanations may use general model
 * knowledge. Repository work, product-meta questions, derivable calculations,
 * and transcript-only audits are not external-fact requests.
 */
export function classifyExternalFactPolicy(value: string): ExternalFactPolicyDecision {
  const text = normalize(value);
  if (!text) {
    return decision(
      "NOT_EXTERNAL_FACT",
      1,
      [],
      "An empty request does not ask for an external fact.",
    );
  }

  if (looksLikeContextDependentFragment(text)) {
    return decision(
      "NOT_EXTERNAL_FACT",
      0.9,
      ["conversation-fragment"],
      "A subjectless follow-up must inherit its topic from conversation context before any evidence policy is chosen.",
    );
  }

  const productMeta = classifyProductMetaIntent(value);
  if (
    (productMeta && (
      productMeta.topic !== "ALL"
      || productMeta.signals.includes("general-capability-scope")
      || productMeta.signals.includes("web-topic")
      || productMeta.signals.includes("repository-write-topic")
    ))
    || looksLikeProductMetaQuestion(text)
  ) {
    return decision(
      "NOT_EXTERNAL_FACT",
      0.98,
      ["product-meta"],
      "Product capability questions are grounded in the local capability registry.",
    );
  }

  if (looksLikeRepositoryOrCodingTask(text)) {
    return decision(
      "NOT_EXTERNAL_FACT",
      0.94,
      ["repository-or-coding-task"],
      "Repository and implementation tasks require local reasoning or repository evidence.",
    );
  }

  if (looksLikeDerivableReasoningTask(text)) {
    return decision(
      "NOT_EXTERNAL_FACT",
      0.9,
      ["derivable-reasoning"],
      "The request asks for a calculation, proof, or other derivation rather than an external fact.",
    );
  }

  const verificationSignals = collectVerificationSignals(value, text);
  const transcriptAudit = looksLikeTranscriptOnlyAudit(text);
  if (transcriptAudit && verificationSignals.length === 0) {
    return decision(
      "NOT_EXTERNAL_FACT",
      0.92,
      ["conversation-record"],
      "The request asks what the assistant previously said, so the conversation record is the evidence source.",
    );
  }

  if (verificationSignals.length > 0) {
    return decision(
      "VERIFICATION_REQUIRED",
      verificationSignals.length > 1 ? 0.94 : 0.86,
      verificationSignals,
      "The requested answer contains precise, exhaustive, volatile, or explicitly challenged external claims.",
    );
  }

  const generalSignals = collectGeneralKnowledgeSignals(text);
  if (generalSignals.length > 0) {
    return decision(
      "GENERAL_KNOWLEDGE",
      generalSignals.length > 1 ? 0.86 : 0.74,
      generalSignals,
      "The request asks for a broad explanation, definition, or overview without requiring exact verification.",
    );
  }

  if (looksLikeExternalQuestion(value, text)) {
    return decision(
      "GENERAL_KNOWLEDGE",
      0.62,
      ["general-question"],
      "The request appears to ask about the world, but it does not demand precise or current evidence.",
    );
  }

  return decision(
    "NOT_EXTERNAL_FACT",
    0.72,
    [],
    "The request does not have the shape of an external factual question.",
  );
}

export function requiresExternalFactVerification(value: string): boolean {
  return classifyExternalFactPolicy(value).policy === "VERIFICATION_REQUIRED";
}

function collectVerificationSignals(raw: string, text: string): string[] {
  const signals: string[] = [];

  if (looksLikeExplicitWebAction(raw)) {
    signals.push("explicit-research");
  }
  if (/(?:核实|核验|查证|确认.{0,8}(?:真假|真伪|事实|是否正确)|事实核查|准确吗|是否准确|是否属实|可靠吗|真的吗|真的是|对不对|有没有依据|证据|出处|来源|引用)|\b(?:verify|fact[- ]?check|validate|confirm whether|is (?:that|this) (?:true|accurate|correct)|really true|evidence|citation|cite|source)\b/i.test(text)) {
    signals.push("explicit-verification");
  }
  if (/(?:今天|今日|昨天|现在|当前|最新|实时|刚刚|最近|本周|本月|今年|价格|比分|赛果|汇率|库存|在售|现任)|\b(?:today|yesterday|now|current|currently|latest|live|recent|this (?:week|month|year)|price|score|exchange rate|in stock|incumbent)\b/i.test(text)) {
    signals.push("volatile-fact");
  }
  const explicitlyExhaustive = /(?:全部|所有|完整(?:名单|列表|清单|目录|明细)|逐个|逐一|分别|清单|列表|每一(?:个|位|家|项|部|季|届))|\b(?:all|every|complete (?:list|catalogue|catalog|inventory)|exhaustive|list (?:all|every)|which (?:ones|people|companies|countries|items|versions))\b/i.test(text);
  const openEnumeration = /(?:有哪些|哪几个|哪一些)|\bwhat (?:are|were) the\b/i.test(text);
  const representativeExamples = /(?:知名|著名|有名|代表性|经典|广为人知)|\b(?:well[- ]known|famous|notable|representative|classic)\b/i.test(text);
  if (explicitlyExhaustive || (openEnumeration && !representativeExamples)) {
    signals.push("exhaustive-or-enumerated");
  }
  if (/(?:谁(?:是|获得|赢得|担任|创立|发明)|哪(?:一)?(?:年|月|天|日|届|季|集|章|版|版本|国家|城市|地点|位置|公司|人物|作品)|何时|什么时候|在哪里|位于哪里|地点(?:是|在哪)|多少(?:个|位|家|年|次|部|项|钱|颗|种)?|几(?:个|位|家|年|次|部|项|颗|种)|哪来(?:的)?|不是.{0,24}吗|是否(?:为|是|有|存在|发生|包含)|有没有.{0,18}(?:发生|存在|包含|获得))|\b(?:who (?:is|was|won|founded|invented|created)|when (?:did|was|is)|where (?:did|was|is|does)|what (?:year|date|version|price|score)|which (?:year|date|version|country|city|place|person)|how (?:many|much|old|long ago))\b/i.test(text)) {
    signals.push("precise-attribute");
  }
  if (/(?:第\s*(?:\d+|[一二三四五六七八九十百两]+)\s*(?:章|关|幕|季|集|部|卷|任|届|次|个|位).{0,24}(?:是谁|是什么|有哪些|发生了什么|结果)|\b(?:chapter|episode|season|volume|round|term)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b.{0,24}\b(?:who|what|which|result)\b)/i.test(text)) {
    signals.push("bounded-relation");
  }
  if (/(?:^|[，。！？?\s])(?:是|不是|有|没有|会|不会|能|不能|可以|不可以).{1,36}吗(?:[？?]|$)|^(?:is|are|was|were|did|does|do|has|have|can|could|will|would)\b(?![^?]{0,24}\b(?:explain|describe|summarize|brainstorm)\b)/i.test(text)) {
    signals.push("polar-factual-claim");
  }

  return [...new Set(signals)];
}

function collectGeneralKnowledgeSignals(text: string): string[] {
  const signals: string[] = [];

  if (/(?:什么是|是什(?:么|麼)(?:意思)?|是什么意思|定义(?:是什么)?|介绍(?:一下)?|概述|讲讲|科普|基本概念)|\b(?:what is|what are|define|definition of|introduce|overview of|tell me about)\b/i.test(text)) {
    signals.push("definition-or-overview");
  }
  if (/(?:解释|原理|为什么|为何|怎么工作|如何运作|工作机制|背后的原因)|\b(?:explain|why (?:is|are|does|do|did)|how (?:does|do|did).{0,40}(?:work|operate|function)|underlying (?:idea|principle|mechanism))\b/i.test(text)) {
    signals.push("explanation");
  }
  if (/(?:你知道|你了解|听说过|了解一下)|\b(?:do you know|are you familiar with|have you heard of)\b/i.test(text)) {
    signals.push("broad-familiarity");
  }
  if (/(?:比较|区别|异同|优缺点)|\b(?:compare|comparison|difference between|pros and cons)\b/i.test(text)) {
    signals.push("conceptual-comparison");
  }
  if (/(?:有哪些|哪几个|举例|例如).{0,12}(?:知名|著名|有名|代表性|经典)|(?:知名|著名|有名|代表性|经典).{0,12}(?:有哪些|哪几个|举例)|\b(?:famous|notable|well[- ]known|representative|classic).{0,16}(?:examples?|songs?|works?|people|places?)\b/i.test(text)) {
    signals.push("representative-examples");
  }

  return [...new Set(signals)];
}

function looksLikeRepositoryOrCodingTask(text: string): boolean {
  const repositoryAnchor = /(?:当前|这个|本地|这里的)?(?:仓库|代码库|项目|目录|文件|源码|工作区)|\b(?:current|local|this)\s+(?:repository|repo|project|directory|file|codebase|workspace)\b|(?:^|[\s"'`])(?:src|tests?|docs?|packages?)\/[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cpp|c|h|md|json|ya?ml)\b/i.test(text);
  const repositoryAction = /(?:修改|新增|创建|删除|保存|写入|修复|重构|审查|检查|分析|运行|测试|构建|部署|提交|实现)|\b(?:modify|add|create|delete|save|write|fix|refactor|review|inspect|analy[sz]e|run|test|build|deploy|commit|implement)\b/i.test(text);
  const codingTarget = /(?:代码|程序|函数|类|接口|组件|脚本|算法|页面|服务|测试用例)|\b(?:code|program|function|class|interface|component|script|algorithm|web ?page|service|test case)\b/i.test(text);
  const implementationFrame = /(?:帮我|请|需要|直接|如何|怎么).{0,12}(?:写|实现|修复|重构|生成|创建)|\b(?:please|help me|how (?:do|can|to)|need to).{0,24}\b(?:write|implement|fix|refactor|generate|create)\b/i.test(text);
  const localBehaviorFrame = /(?:当前|现有|现在的)(?:行为|实现|逻辑|功能|代码)|\b(?:current|existing)\s+(?:behavior|implementation|logic|functionality|code)\b/i.test(text);

  return (repositoryAnchor && repositoryAction)
    || (codingTarget && implementationFrame)
    || localBehaviorFrame;
}

function looksLikeContextDependentFragment(text: string): boolean {
  return /^(?:(?:那|那么|然后|还有|这个|那个|这些|那些|它|现在)(?:呢|怎么样|如何|又如何)?|(?:在)?哪(?:里|儿)|放哪(?:里|儿)?了?|路径(?:是什么|呢)?|怎么打开|where(?:\s+is\s+it)?|which\s+file|how\s+do\s+i\s+open\s+it|and (?:that|this|it)\??)$/i
    .test(text.replace(/[。！？?]+$/g, ""));
}

function looksLikeProductMetaQuestion(text: string): boolean {
  const assistantSubject = /(?:你|这个(?:cli|助手|agent)|mini[\s-]*(?:agent|coding agent))|\b(?:you|this (?:cli|assistant|agent))\b/i.test(text);
  const capabilityTopic = /(?:联网|上网|互联网|外网|访问网页|写入|修改|编辑|创建|保存).{0,8}(?:能力|文件|代码|仓库)?|\b(?:browse|internet|web search|write|edit|modify|create)\b.{0,12}\b(?:files?|code|repository)?/i.test(text);
  const modality = /(?:能|可以|支持|具备|会不会|有没有|权限|不能|无法)|\b(?:can|could|able|support|capabilit|permission)\b/i.test(text);

  return assistantSubject && capabilityTopic && modality;
}

function looksLikeDerivableReasoningTask(text: string): boolean {
  if (/(?:计算|算出|求解|解方程|化简|证明|推导)|\b(?:calculate|compute|solve|simplify|prove|derive)\b/i.test(text)) {
    return true;
  }

  return /(?:^|\s)-?\d+(?:\.\d+)?\s*(?:[+\-*/×÷^]|mod)\s*-?\d+(?:\.\d+)?(?:\s*等于多少|\s*[=?？])/i.test(text);
}

function looksLikeTranscriptOnlyAudit(text: string): boolean {
  const priorAssistantReference = /(?:(?:你|助手).{0,12}(?:刚才|之前|前面|上一轮|曾经)?.{0,8}(?:说|写|回答|提到|声称|输出)|(?:你的|助手的).{0,6}(?:回答|原话|输出)|自己看看.{0,8}(?:回答|原话|输出))|\b(?:you|the assistant).{0,18}(?:said|wrote|answered|mentioned|claimed|output)|\b(?:your|the assistant's)\s+(?:answer|words|output)\b/i.test(text);
  const recordQuestion = /(?:是不是|是否|有没有|说过|写过|提过|原话|到底说了什么|自己看看)|\b(?:did you|have you|what did you|your exact words|check (?:your|the) (?:answer|record))\b/i.test(text);
  const asksTruthOfClaim = /(?:核实|核验|查证|事实核查|准确吗|是否准确|是否属实|真的吗|对不对|是否正确|真假|真伪)|\b(?:verify|fact[- ]?check|is (?:that|this) (?:true|accurate|correct)|was (?:that|this) correct)\b/i.test(text);

  return priorAssistantReference && recordQuestion && !asksTruthOfClaim;
}

function looksLikeExternalQuestion(raw: string, text: string): boolean {
  if (/[?？]/.test(raw)) {
    return true;
  }

  return /(?:吗|呢|谁|什么|为何|为什么|怎么|如何|介绍|解释|讲讲|告诉我)|^(?:what|why|how|who|tell me|describe|explain)\b/i.test(text);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function decision(
  policy: ExternalFactPolicy,
  confidence: number,
  signals: string[],
  reason: string,
): ExternalFactPolicyDecision {
  return { policy, confidence, signals, reason };
}
