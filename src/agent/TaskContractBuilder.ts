import type { AgentOperatingMode } from "./AgentOperatingMode.js";
import type { AgentTaskContract } from "./AgentTaskContract.js";
import { looksLikeExplicitWebAction } from "./ProductCapability.js";
import {
  looksLikeIndexedKnowledgeRequest,
  looksLikeRepositoryAnalysisTask,
} from "./TaskRouter.js";
import type { TaskRoute } from "./TaskRouter.js";
import { looksLikeCompleteFileReadRequest } from "./FileReadCoverage.js";
import { looksLikeTemporalSuperlativeRequest } from "./WebResearchPolicy.js";

export interface BuildAgentTaskContractInput {
  userGoal: string;
  route: TaskRoute;
  operatingMode?: AgentOperatingMode;
  forceIterative?: boolean;
  multiAgentEnabled?: boolean;
}

export function buildAgentTaskContract(input: BuildAgentTaskContractInput): AgentTaskContract {
  if (input.operatingMode === "PLAN") {
    const base = buildExecuteContract({ ...input, operatingMode: "EXECUTE" });
    return {
      ...base,
      outputKind: "IMPLEMENTATION_PLAN",
      executionStrategy: "ITERATIVE",
      resultMode: "PLAN",
      capabilities: {
        ...base.capabilities,
        repositoryWrite: false,
        commandExecution: false,
      },
      evidence: {
        ...base.evidence,
        fetchedWebSourceCount: 0,
        independentWebDomainCount: 0,
      },
      maxSteps: Math.max(base.maxSteps, 10),
      instructions: [
        ...base.instructions,
        "Produce a concrete read-only implementation plan; do not claim that repository changes were applied.",
      ],
    };
  }

  const contract = buildExecuteContract(input);
  if (!input.forceIterative || contract.executionStrategy === "ITERATIVE") {
    return contract;
  }

  return {
    ...contract,
    executionStrategy: "ITERATIVE",
    maxSteps: Math.max(contract.maxSteps, 6),
    instructions: [
      ...contract.instructions,
      "Use the iterative decision protocol without expanding the capabilities granted by this task contract.",
    ],
  };
}

function buildExecuteContract(input: BuildAgentTaskContractInput): AgentTaskContract {
  if (looksLikeIndexedKnowledgeRequest(input.userGoal)) {
    return {
      version: 1,
      kind: "KNOWLEDGE_QUERY",
      outputKind: "NATURAL_LANGUAGE",
      executionStrategy: "ITERATIVE",
      resultMode: input.route.intent,
      capabilities: capabilities({ repositoryRead: false, knowledgeAccess: true }),
      evidence: evidence({ knowledgeSearch: true }),
      maxSteps: 6,
      routeReason: input.route.reason,
      instructions: [
        "Answer only from knowledge_search evidence and preserve exact file-and-line citations.",
        "If indexed evidence is insufficient, state that limitation instead of answering from memory.",
      ],
    };
  }

  switch (input.route.intent) {
    case "DIRECT_ANSWER":
      return {
        version: 1,
        kind: "DIRECT_RESPONSE",
        outputKind: "NATURAL_LANGUAGE",
        executionStrategy: "SINGLE_SHOT",
        resultMode: "DIRECT_ANSWER",
        capabilities: capabilities({}),
        evidence: evidence({}),
        maxSteps: 1,
        routeReason: input.route.reason,
        instructions: [
          "Answer the user directly. Do not inspect or modify repository files and do not use web facts.",
          "Treat unaided model memory as unverified general knowledge, not as retrieved evidence.",
          "Do not invent exhaustive lists, exact locations, dates, quantities, drops, mechanics, or similarly precise external details. Narrow the answer or state that verification is required when confidence is insufficient.",
          "When the user challenges an earlier answer, first establish what the visible conversation record says. Acknowledge contradictions and re-check the related claim cluster instead of patching one detail or replacing it with new unsupported facts.",
        ],
      };

    case "WEB_ANSWER": {
      const live = needsMultipleCurrentSources(input.userGoal);
      const temporalSuperlative = looksLikeTemporalSuperlativeRequest(input.userGoal);
      return {
        version: 1,
        kind: "WEB_RESEARCH",
        outputKind: "GROUNDED_WEB_ANSWER",
        executionStrategy: "ITERATIVE",
        resultMode: "WEB_ANSWER",
        capabilities: capabilities({ webAccess: true }),
        evidence: evidence({
          webSearch: true,
          fetchedWebSourceCount: live && !temporalSuperlative ? 2 : 1,
          independentWebDomainCount: live && !temporalSuperlative ? 2 : 1,
          webCitation: true,
        }),
        maxSteps: 10,
        routeReason: input.route.reason,
        instructions: [
          "The first web_search query must preserve the user's entity, scope, and qualifiers. Add retrieval synonyms only in later queries; never strengthen 知名/famous/notable into 最/most/top/best unless the user requested a ranking.",
          "Search first, then fetch important sources before answering.",
          ...(temporalSuperlative ? [
            "This is a temporal superlative claim. Run at least two non-equivalent searches, including an authority-targeted freshness search using official/官方, release notes, changelog, or a site: constraint; compare newer dated/versioned candidates before claiming what is latest.",
            "Search-engine rank is not chronological order. Prefer a canonical first-party current-model, release-index, changelog, or product page over a stale secondary roundup.",
          ] : []),
          "Cite only URLs returned by web_search or fetch_url; never invent or repair a URL.",
          "If web_search fails at the transport/provider layer, do not retry equivalent wording or guess a likely fetch_url. Explicitly report insufficient web evidence.",
          "If the evidence threshold cannot be met, report insufficient evidence without asserting current facts.",
          "For sports results, keep competitions separate; for ambiguous entities, preserve multiple verified interpretations instead of silently choosing one.",
        ],
      };
    }

    case "CODE_REVIEW":
      return repositoryInvestigationContract("CODE_REVIEW", input.userGoal, input.route.reason, [
        "Read the requested file and relevant dependencies before reviewing it.",
        "The primary review target requires complete line coverage. Continue read_file from nextStartLine and nextStartColumn while hasMore is true.",
        "Report only actionable correctness, security, or maintainability findings grounded in repository evidence.",
        "For every finding include severity, repository path, line number, reasoning, and a concise remediation.",
        "If no grounded issue is found, say so explicitly and mention what was inspected.",
      ]);

    case "AGENT_LOOP":
      if (looksLikeRepositoryAnalysisTask(input.userGoal)) {
        return repositoryInvestigationContract("REPOSITORY_ANALYSIS", input.userGoal, input.route.reason, [
          "Inspect the repository tree and representative source, build, configuration, and documentation files.",
          "Separate confirmed facts from inference and cite supporting repository paths.",
          "Cover the major modules and runtime flow before proposing improvements.",
        ]);
      }
      return repositoryTaskContract(input.userGoal, input.route.reason, input.multiAgentEnabled === true);
  }
}

function repositoryInvestigationContract(
  outputKind: "CODE_REVIEW" | "REPOSITORY_ANALYSIS",
  userGoal: string,
  routeReason: string,
  instructions: string[],
): AgentTaskContract {
  return {
    version: 1,
    kind: "REPOSITORY_INVESTIGATION",
    outputKind,
    executionStrategy: "ITERATIVE",
    resultMode: outputKind === "CODE_REVIEW" ? "CODE_REVIEW" : "AGENT_LOOP",
    capabilities: capabilities({ repositoryRead: true }),
    evidence: evidence({
      repositoryRead: true,
      completeFileRead: outputKind === "CODE_REVIEW" || looksLikeCompleteFileReadRequest(userGoal),
    }),
    maxSteps: outputKind === "CODE_REVIEW" ? 20 : 14,
    routeReason,
    instructions,
  };
}

function repositoryTaskContract(userGoal: string, routeReason: string, delegation: boolean): AgentTaskContract {
  const webAccess = looksLikeExplicitWebAction(userGoal);
  const knowledgeAccess = looksLikeIndexedKnowledgeRequest(userGoal);
  const mcpAccess = /(?:\bmcp\b|外部工具|连接器|\bconnector\b)/i.test(userGoal);
  return {
    version: 1,
    kind: "REPOSITORY_TASK",
    outputKind: "TASK_RESULT",
    executionStrategy: "ITERATIVE",
    resultMode: "AGENT_LOOP",
    capabilities: capabilities({
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      webAccess,
      knowledgeAccess,
      delegation,
      mcpAccess,
    }),
    evidence: evidence({ completeFileRead: looksLikeCompleteFileReadRequest(userGoal) }),
    maxSteps: 20,
    routeReason,
    instructions: [
      "Use repository evidence before editing and verify changes according to the completion contract.",
    ],
  };
}

function capabilities(overrides: Partial<AgentTaskContract["capabilities"]>): AgentTaskContract["capabilities"] {
  return {
    repositoryRead: false,
    repositoryWrite: false,
    commandExecution: false,
    webAccess: false,
    knowledgeAccess: false,
    delegation: false,
    mcpAccess: false,
    ...overrides,
  };
}

function evidence(overrides: Partial<AgentTaskContract["evidence"]>): AgentTaskContract["evidence"] {
  return {
    repositoryRead: false,
    completeFileRead: false,
    webSearch: false,
    fetchedWebSourceCount: 0,
    independentWebDomainCount: 0,
    webCitation: false,
    knowledgeSearch: false,
    ...overrides,
  };
}

function needsMultipleCurrentSources(userGoal: string): boolean {
  return /(?:今天|今日|现在|当前|最新|实时|刚刚|最近|收盘|比分|价格|版本)|\b(?:today|now|current|latest|live|recent|price|score|version)\b/i.test(userGoal);
}
