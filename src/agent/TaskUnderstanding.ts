import { hasHighConfidenceDiagnostic } from "../diagnostics/ErrorClassifier.js";
import { isPriorResponseAuditRequest } from "../session/ConversationHistory.js";
import {
  hasExplicitChatOnlyConstraint,
  looksLikeDocumentCreationTask,
  mentionsDocumentArtifact,
} from "./ArtifactIntent.js";
import { classifyExternalFactPolicy, type ExternalFactPolicy } from "./ExternalFactPolicy.js";
import {
  classifyProductMetaIntent,
  looksLikeExplicitWebAction,
} from "./ProductCapability.js";
import {
  extractLikelyReviewFilePath,
  looksLikeReviewableFilePath,
} from "./RepositoryInvestigation.js";
import {
  looksLikeFileWriteConfirmation,
  looksLikeSaveToFileFollowUp,
} from "./TaskFollowUp.js";
import { classifySubAgentIntent } from "./SubAgentIntent.js";

export type TaskOperation =
  | "ANSWER"
  | "RESEARCH"
  | "REVIEW_REPOSITORY"
  | "ANALYZE_REPOSITORY"
  | "CHANGE_REPOSITORY"
  | "QUERY_KNOWLEDGE"
  | "LOCAL_STATE";

export type TaskTarget = "WORLD" | "REPOSITORY" | "PRODUCT" | "SESSION" | "DERIVATION";

export type TaskAnswerShape =
  | "DEFINITION"
  | "COUNT"
  | "ENUMERATION"
  | "RELATION"
  | "IDENTITY"
  | "EXPLANATION"
  | "FREEFORM";

export type RequestedAnswerDepth = "BRIEF" | "BALANCED" | "DETAILED";

export interface TaskUnderstanding {
  operation: TaskOperation;
  target: TaskTarget;
  answerShape: TaskAnswerShape;
  answerDepth: RequestedAnswerDepth;
  externalFactPolicy: ExternalFactPolicy;
  explicitWeb: boolean;
  explicitRepositoryTarget: boolean;
  explicitMutation: boolean;
  completeFileRead: boolean;
  confidence: number;
  signals: string[];
}

/**
 * Builds the semantic control-plane record for one user turn. Downstream
 * routing, contracts, and answer guidance should consume this record instead
 * of independently interpreting the raw sentence.
 */
export function understandTask(userGoal: string): TaskUnderstanding {
  const text = normalize(userGoal);
  const signals: string[] = [];
  const external = classifyExternalFactPolicy(userGoal);
  const answerShape = classifyAnswerShape(text, external.policy);
  const answerDepth = classifyAnswerDepth(text);
  const explicitWeb = looksLikeExplicitWebAction(userGoal);
  const productMeta = classifyProductMetaIntent(userGoal);
  const subAgentIntent = classifySubAgentIntent(userGoal);
  const reviewPath = extractLikelyReviewFilePath(userGoal);
  const explicitPath = reviewPath !== undefined || looksLikeReviewableFilePath(userGoal.trim());
  const repositoryAnchor = hasRepositoryAnchor(text) || explicitPath;
  const mutation = hasRepositoryMutationFrame(text)
    || looksLikeSaveToFileFollowUp(userGoal)
    || looksLikeDocumentCreationTask(userGoal);
  const review = hasRepositoryReviewFrame(text, explicitPath);
  const analysis = hasRepositoryAnalysisFrame(text);
  const codeCreation = hasCodeArtifactCreationFrame(text);
  const completeFileRead = /(?:完整|全部|从头到尾|逐行|整个).{0,12}(?:读取|阅读|检查|审查|文件)|\b(?:entire|whole|complete).{0,12}\b(?:read|review|file)\b/i.test(text);

  if (
    productMeta
    && productMeta.confidence >= 0.65
    && !(isPriorResponseAuditRequest(userGoal) && explicitWeb)
    && !hasFeatureImplementationFrame(text)
  ) {
    signals.push("product-meta");
    return result("LOCAL_STATE", "PRODUCT", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: false,
      explicitMutation: false,
      completeFileRead: false,
      confidence: productMeta.confidence,
      signals,
    });
  }

  if (subAgentIntent.preference === "REQUIRED") {
    signals.push(...subAgentIntent.signals);
    return result(
      subAgentIntent.requestsChangeProposal ? "CHANGE_REPOSITORY" : "ANALYZE_REPOSITORY",
      "REPOSITORY",
      {
        answerShape,
        answerDepth,
        externalFactPolicy: "NOT_EXTERNAL_FACT",
        explicitWeb: false,
        explicitRepositoryTarget: true,
        explicitMutation: subAgentIntent.requestsChangeProposal,
        completeFileRead,
        confidence: 0.98,
        signals,
      },
    );
  }

  if (
    looksLikeFileWriteConfirmation(userGoal)
    || looksLikeConversationStateQuestion(text)
    || (isPriorResponseAuditRequest(userGoal) && !explicitWeb)
  ) {
    signals.push(looksLikeFileWriteConfirmation(userGoal) ? "file-change-state" : "conversation-record");
    return result("LOCAL_STATE", "SESSION", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb,
      explicitRepositoryTarget: false,
      explicitMutation: false,
      completeFileRead: false,
      confidence: 0.96,
      signals,
    });
  }

  if (hasHighConfidenceDiagnostic({ text: userGoal, repoPath: "." })) {
    signals.push("local-diagnostic");
    return result("LOCAL_STATE", "REPOSITORY", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: true,
      explicitMutation: false,
      completeFileRead: false,
      confidence: 0.94,
      signals,
    });
  }

  if (looksLikeIndexedKnowledgeRequest(userGoal)) {
    signals.push("indexed-knowledge");
    return result("QUERY_KNOWLEDGE", "REPOSITORY", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: true,
      explicitMutation: false,
      completeFileRead: false,
      confidence: 0.96,
      signals,
    });
  }

  if (mentionsDocumentArtifact(userGoal) && hasExplicitChatOnlyConstraint(userGoal)) {
    signals.push("chat-only-artifact");
    return result("ANSWER", "DERIVATION", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: false,
      explicitMutation: false,
      completeFileRead: false,
      confidence: 0.95,
      signals,
    });
  }

  if (looksLikeAdviceRatherThanCreation(text)) {
    signals.push("advice-not-mutation");
    return result("ANSWER", "DERIVATION", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: false,
      explicitMutation: false,
      completeFileRead: false,
      confidence: 0.94,
      signals,
    });
  }

  if (
    codeCreation
    || looksLikeDocumentCreationTask(userGoal)
    || looksLikeSaveToFileFollowUp(userGoal)
    || (mutation && repositoryAnchor)
    || hasFeatureImplementationFrame(text)
    || /^(?:test|测试)(?:一下)?[。.!！]?$/.test(text)
    || /^(?:(?:test\b)|测试|运行测试|执行测试).{0,24}(?:current|this|the|当前|这个|本)?\s*(?:project|repository|repo|项目|仓库)?[。.!！]?$/i.test(text)
  ) {
    signals.push("repository-mutation");
    return result("CHANGE_REPOSITORY", "REPOSITORY", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb,
      explicitRepositoryTarget: true,
      explicitMutation: true,
      completeFileRead,
      confidence: repositoryAnchor ? 0.96 : 0.88,
      signals,
    });
  }

  if (review || looksLikeReviewableFilePath(userGoal.trim())) {
    signals.push("repository-review");
    return result("REVIEW_REPOSITORY", "REPOSITORY", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: true,
      explicitMutation: false,
      completeFileRead: completeFileRead || explicitPath,
      confidence: explicitPath ? 0.96 : 0.84,
      signals,
    });
  }

  if (analysis && repositoryAnchor) {
    signals.push("repository-analysis");
    return result("ANALYZE_REPOSITORY", "REPOSITORY", {
      answerShape,
      answerDepth,
      externalFactPolicy: "NOT_EXTERNAL_FACT",
      explicitWeb: false,
      explicitRepositoryTarget: true,
      explicitMutation: false,
      completeFileRead,
      confidence: 0.92,
      signals,
    });
  }

  const preciseOutcome = /(?:谁赢|谁获胜|比赛结果|最终结果|得分|比分|赛果)|\b(?:who won|winner|final result|score)\b/i.test(text);
  if (explicitWeb || external.policy === "VERIFICATION_REQUIRED" || preciseOutcome) {
    if (preciseOutcome) signals.push("precise-outcome");
    signals.push(...external.signals);
    return result("RESEARCH", "WORLD", {
      answerShape,
      answerDepth,
      externalFactPolicy: external.policy,
      explicitWeb,
      explicitRepositoryTarget: false,
      explicitMutation: false,
      completeFileRead: false,
      confidence: Math.max(external.confidence, explicitWeb ? 0.98 : 0),
      signals,
    });
  }

  signals.push(...external.signals);
  return result("ANSWER", external.policy === "NOT_EXTERNAL_FACT" ? "DERIVATION" : "WORLD", {
    answerShape,
    answerDepth,
    externalFactPolicy: external.policy,
    explicitWeb: false,
    explicitRepositoryTarget: false,
    explicitMutation: false,
    completeFileRead: false,
    confidence: Math.max(0.72, external.confidence),
    signals,
  });
}

export function looksLikeIndexedKnowledgeRequest(value: string): boolean {
  const normalized = normalize(value);
  const compact = normalized.replace(/[\s,，。.!！？?;；:：“”"'‘’、\-—()（）[\]【】]/g, "");
  const capabilityQuestion = /^(?:(?:你|这个项目|本项目|这个cli|这个agent|该agent))?(?:有|有没有|是否有|支持|具备)(?:rag(?:系统)?|知识库(?:系统)?|检索增强生成(?:系统)?)(?:功能|能力)?(?:吗)?$/i.test(compact)
    || /^\s*(?:do|does)\s+(?:you|this (?:cli|project|agent))\s+(?:have|support)\s+(?:(?:a|an)\s+)?(?:rag(?:\s+system)?|knowledge\s+base)(?:\s+(?:feature|capability))?\s*[?.!]*$/i.test(value);
  if (capabilityQuestion) return false;
  return [
    /(?:根据|查询|检索|搜索|查找|从).{0,12}(?:已索引的?)?(?:知识库|知识文档|文档索引)/i,
    /(?:知识库|已索引的?文档|文档索引)(?:里|中|内|里的|中的).+/i,
    /(?:请)?(?:用|使用|通过|调用)(?:已索引的?)?(?:知识库|rag).{0,8}(?:查|查询|检索|搜索|回答)/i,
    /\b(?:search|query|look up|according to|from)\s+(?:the\s+)?(?:indexed\s+)?(?:knowledge base|knowledge documents?)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function classifyAnswerShape(value: string, externalFactPolicy: ExternalFactPolicy): TaskAnswerShape {
  if (/(?:多少(?:个|位|家|项|种|部|次|名|所|间|只|条)?|几(?:个|位|家|项|种|部|次|名|所|间|只|条)|数量(?:是|有)?多少)|\b(?:how many|what is the (?:count|number) of)\b/i.test(value)) {
    return "COUNT";
  }
  if (/(?:全部|所有|完整(?:名单|列表|清单)|列出|枚举|分别|有哪些|哪几个|哪一些)|\b(?:list|enumerate|all|which ones|what are the)\b/i.test(value)) {
    return "ENUMERATION";
  }
  if (/(?:谁是|是谁)|\bwho (?:is|was|are|were)\b/i.test(value)) {
    return "IDENTITY";
  }
  if (/(?:解释|原理|为什么|为何|怎么工作|如何运作|工作机制)|\b(?:explain|why|how does|how do|mechanism)\b/i.test(value)) {
    return "EXPLANATION";
  }
  if (/(?:什么是|是什么意思|定义(?:是什么)?)|\b(?:what is|what are|define|definition of)\b/i.test(value)) {
    return "DEFINITION";
  }
  if (/(?:是什么)(?:[?？。.!！]|$)/i.test(value)) {
    return externalFactPolicy === "VERIFICATION_REQUIRED" || /的[^的\s]{1,24}是什么/i.test(value)
      ? "RELATION"
      : "DEFINITION";
  }
  if (/[?？]/.test(value) || /(?:哪里|何时|什么时候|哪年|哪天|哪个|哪一)/i.test(value)) {
    return "RELATION";
  }
  return "FREEFORM";
}

function classifyAnswerDepth(value: string): RequestedAnswerDepth {
  if (/(?:一句话|简短|简要|简单回答|只要答案|不要展开)|\b(?:brief|briefly|short answer|one sentence|just the answer|tldr)\b/i.test(value)) {
    return "BRIEF";
  }
  if (/(?:详细|全面|深入|展开|完整解释|具体分析|逐项)|\b(?:detailed|in depth|comprehensive|expand on|step by step)\b/i.test(value)) {
    return "DETAILED";
  }
  return "BALANCED";
}

function hasRepositoryAnchor(value: string): boolean {
  return /(?:当前|现有|这个|本地|这里的|刚才的|我们的).{0,8}(?:仓库|代码库|项目|目录|文件|源码|工作区|代码)|(?:仓库|代码库|工作区)(?:里|中|内|的)|(?:修改|新增|增加|添加|删除|移除|保存|写入|写进|修复|重构|更新).{0,12}(?:文件|代码|readme)|(?:文件|代码|readme).{0,12}(?:修改|新增|增加|添加|删除|保存|写入|修复|更新)|\b(?:current|existing|this|local|our)\s+(?:repository|repo|codebase|workspace|source|file|project)\b|\b(?:inspect|review|analy[sz]e|summarize)\b.{0,20}\b(?:repository|repo|codebase|workspace|project)\b|\b(?:change|modify|add|append|create|delete|remove|save|write|fix|refactor|update|edit)\b.{0,20}\b(?:file|code|readme|[\w.-]+\.[a-z0-9]+)\b|(?:^|[\s"'`])(?:src|tests?|docs?|packages?)\/[\w./-]+|(?:^|[\s"'`])readme(?:\.[a-z0-9]+)?\b|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|c|h|html|css|md|mdx|txt|json|ya?ml|toml|xml)\b/i.test(value);
}

function hasRepositoryMutationFrame(value: string): boolean {
  const action = /(?:修改|新增|增加|添加|追加|创建|新建|删除|移除|保存|写入|写进|修复|重构|实现|更新|应用补丁)|\b(?:change|modify|add|append|create|delete|remove|save|write|fix|refactor|update|edit|apply)\b/i.test(value);
  return action && hasRepositoryAnchor(value);
}

function looksLikeConversationStateQuestion(value: string): boolean {
  return /(?:还记得|记不记得|回顾|总结).{0,18}(?:刚才|之前|前面|上一轮|这轮|我们).{0,12}(?:聊|说|讨论|对话|内容)|(?:刚才|之前|前面|上一轮|这轮).{0,12}(?:聊了什么|说了什么|讨论了什么)|\b(?:do you remember|recap|summari[sz]e).{0,24}\b(?:our|the|previous|earlier|last).{0,12}\b(?:conversation|discussion|chat|exchange)\b/i.test(value);
}

function hasCodeArtifactCreationFrame(value: string): boolean {
  const action = /(?:写个|写一个|帮我写|做个|做一个|实现一个|生成一个|创建一个)|^(?:请|帮我|直接)?(?:实现|编写|创建|生成).{1,80}$|\b(?:build|create|write|implement|scaffold)\s+(?:a|an|the)?\s*/i.test(value);
  const artifact = /(?:代码|程序|游戏|页面|脚本|组件|服务|接口|工具|算法|函数|类|测试用例|文档)|\b(?:code|program|game|web ?page|script|component|service|api|tool|algorithm|function|class|test|document|readme)\b/i.test(value);
  const explicitCodingRequest = /(?:帮我|请).{0,6}(?:写个|写一个|实现|生成)|\b(?:implement|scaffold)\b/i.test(value);
  const explanatory = /(?:如何|怎么|为什么|原理|解释|介绍|是什么|吗[?？。!！]?$)|\b(?:how|why|explain|describe|what is)\b/i.test(value);
  return action && (artifact || explicitCodingRequest) && !explanatory;
}

function hasRepositoryReviewFrame(value: string, explicitPath: boolean): boolean {
  const review = /(?:代码审查|审查|检查|排查|找出|看看).{0,80}(?:bug|问题|缺陷|隐患|代码|文件)|\b(?:code review|review|inspect|check|find).{0,80}\b(?:bugs?|issues?|defects?|files?|code)\b/i.test(value);
  return review && (explicitPath || hasRepositoryAnchor(value));
}

function hasFeatureImplementationFrame(value: string): boolean {
  const productOrRepositorySubject = /(?:agent|助手|cli|项目|仓库|代码|系统|功能|能力)/i.test(value);
  const implementation = /(?:补齐|补上|补全|新增|添加|接入|完善|开发|修复|改造|落地|实现).{0,40}(?:功能|能力|支持|缓存|rag|知识库|工具)|(?:功能|能力|支持|缓存|rag|知识库|工具).{0,60}(?:需要|应该|必须)?(?:补齐|补上|补全|新增|添加|接入|完善|开发|修复|改造|落地|实现)|(?:让|使).{0,30}(?:支持|具备|能够)|\b(?:implement|add|fix|complete|build|support)\b.{0,40}\b(?:feature|capability|cache|rag|tool)\b/i.test(value);
  return productOrRepositorySubject && implementation;
}

function looksLikeAdviceRatherThanCreation(value: string): boolean {
  return /^(?:如何|怎么|怎样).{0,40}(?:写|创建|实现|设计)|\bhow\s+to\s+(?:write|create|implement|design|build)\b/i.test(value);
}

function hasRepositoryAnalysisFrame(value: string): boolean {
  return /(?:分析|总结|概括|介绍|梳理).{0,16}(?:仓库|代码库|项目|模块|架构|结构)|(?:仓库|代码库|项目).{0,16}(?:分析|结构|架构|概览|总结)|\b(?:analy[sz]e|explain|summarize|inspect).{0,24}\b(?:repository|repo|codebase|project|architecture|modules?)\b/i.test(value);
}

function result(
  operation: TaskOperation,
  target: TaskTarget,
  rest: Omit<TaskUnderstanding, "operation" | "target">,
): TaskUnderstanding {
  return { operation, target, ...rest, signals: [...new Set(rest.signals)] };
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
