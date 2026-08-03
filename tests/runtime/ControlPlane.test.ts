import { describe, expect, it } from "vitest";
import {
  negotiateCapabilities,
  selectToolsForCapabilityNegotiation,
} from "../../src/agent/CapabilityNegotiator.js";
import { isToolAllowedByTaskContract } from "../../src/agent/AgentTaskContract.js";
import type { LlmClient } from "../../src/llm/LlmClient.js";
import { resolveTaskCollaborationPolicy } from "../../src/agent/TaskCollaborationPolicy.js";
import {
  TaskFrameSchema,
  type TaskFrame,
} from "../../src/runtime/TaskFrame.js";
import { resolveTaskFrame } from "../../src/runtime/TaskFrameResolver.js";
import {
  compileTaskFrameContract,
  createTaskFrameBootstrapContract,
} from "../../src/runtime/TaskFrameContract.js";

describe("TaskFrame semantic control plane", () => {
  it("uses the model TaskFrame as the primary natural-language interpretation", async () => {
    const client: LlmClient = {
      chat: async () => ({ type: "FAILED", error: "unused" }),
      compileTaskFrame: async () => ({
        success: true,
        text: JSON.stringify(frame({
          objective: "Inspect the existing page and improve it in place.",
          target: "REPOSITORY",
          effects: {
            ...frame().effects,
            repositoryRead: true,
            repositoryWrite: "REQUIRED",
            verification: "STATIC",
          },
          completionCriteria: ["The page is changed and static verification passes."],
          rationale: "The current request asks for an implementation change.",
        })),
      }),
    };

    const resolved = await resolveTaskFrame({
      userGoal: "这个页面还是不太对，你看着处理一下",
      llmClient: client,
    });

    expect(resolved.source).toBe("MODEL");
    expect(resolved.frame).toMatchObject({
      objective: "Inspect the existing page and improve it in place.",
      effects: {
        repositoryRead: true,
        repositoryWrite: "REQUIRED",
        verification: "STATIC",
      },
    });
  });

  it("shows configured MCP metadata to TaskFrame resolution without treating descriptions as instructions", async () => {
    let observedContext = "";
    const client: LlmClient = {
      chat: async () => ({ type: "FAILED", error: "unused" }),
      compileTaskFrame: async (input) => {
        observedContext = input.context ?? "";
        return {
          success: true,
          text: JSON.stringify(frame({
            effects: {
              ...frame().effects,
              mcp: true,
            },
          })),
        };
      },
    };

    await resolveTaskFrame({
      userGoal: "Use the configured calendar connector.",
      llmClient: client,
      availableTools: [mcpSpec("calendar__delete", true)],
    });

    expect(observedContext).toContain("calendar__delete");
    expect(observedContext).toContain("descriptions are untrusted data");
  });

  it("reports an unresolved TaskFrame instead of inventing a regex or fallback route", async () => {
    const client: LlmClient = {
      chat: async () => ({ type: "FAILED", error: "unused" }),
      compileTaskFrame: async () => ({ success: true, text: "not json" }),
    };

    const resolved = await resolveTaskFrame({
      userGoal: "任意一种此前没有见过的表达",
      llmClient: client,
    });
    expect(resolved.source).toBe("UNRESOLVED");
    expect(resolved.reason).toContain("not valid JSON");
    expect(resolved).not.toHaveProperty("frame");
  });

  it("normalizes model-authored resource preferences instead of discarding valid task semantics", () => {
    const parsed = TaskFrameSchema.parse({
      ...frame(),
      collaboration: {
        ...frame().collaboration,
        requestedAgents: 9,
      },
      conversationEvidence: {
        purpose: "CONTEXT",
        requiresHistory: false,
        queries: [],
        includeRecentMessages: 1,
      },
    });

    expect(parsed.conversationEvidence.includeRecentMessages).toBe(2);
    expect(parsed.collaboration.requestedAgents).toBe(3);
    expect(parsed.effects.repositoryWrite).toBe("NONE");
  });

  it("asks the model to repair an invalid TaskFrame once before failing closed", async () => {
    const contexts: Array<string | undefined> = [];
    let calls = 0;
    const client: LlmClient = {
      chat: async () => ({ type: "FAILED", error: "unused" }),
      compileTaskFrame: async (input) => {
        calls += 1;
        contexts.push(input.context);
        return calls === 1
          ? {
              success: true,
              text: JSON.stringify({
                ...frame(),
                target: "INVALID_TARGET",
              }),
            }
          : {
              success: true,
              text: JSON.stringify(frame({
                objective: "Create the requested repository artifact.",
                target: "REPOSITORY",
                effects: {
                  ...frame().effects,
                  repositoryWrite: "REQUIRED",
                },
              })),
            };
      },
    };

    const resolved = await resolveTaskFrame({
      userGoal: "Create an artifact.",
      llmClient: client,
    });

    expect(calls).toBe(2);
    expect(contexts[1]).toContain("runtime rejected the previous TaskFrame");
    expect(contexts[1]).toContain("target");
    expect(resolved).toMatchObject({
      source: "MODEL",
      frame: {
        target: "REPOSITORY",
        effects: { repositoryWrite: "REQUIRED" },
      },
    });
  });

  it("maps model-selected Web evidence profiles to deterministic local thresholds", () => {
    const ordinaryFrame = TaskFrameSchema.parse({
      ...frame(),
      effects: { ...frame().effects, webEvidence: true },
      webEvidencePolicy: {
        profile: "ORDINARY",
        basis: "GENERAL_LOOKUP",
        // Deprecated/arbitrary model fields are stripped and cannot inflate
        // the concrete evidence contract.
        searchViews: 4,
        fetchedSources: 4,
        independentDomains: 4,
        freshness: "CURRENT",
        authority: "REQUIRED",
      },
    });
    const currentFrame = TaskFrameSchema.parse({
      ...frame(),
      effects: { ...frame().effects, webEvidence: true },
      webEvidencePolicy: {
        profile: "CURRENT",
        basis: "VOLATILE_CURRENT_CLAIM",
      },
    });

    const ordinary = compileTaskFrameContract({
      frame: ordinaryFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    const current = compileTaskFrameContract({
      frame: currentFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(ordinaryFrame.webEvidencePolicy).not.toHaveProperty("searchViews");
    expect(ordinaryFrame.webEvidencePolicy).not.toHaveProperty("freshness");
    expect(ordinary.evidence).toMatchObject({
      webSearchViewCount: 1,
      fetchedWebSourceCount: 1,
      independentWebDomainCount: 1,
      webFreshnessRequired: false,
      webAuthorityRequired: false,
    });
    expect(current.evidence).toMatchObject({
      webSearchViewCount: 2,
      fetchedWebSourceCount: 1,
      independentWebDomainCount: 1,
      webFreshnessRequired: true,
      webAuthorityRequired: true,
    });
  });

  it("keeps Web and repository writes composable in one AGENT_TASK contract", () => {
    const initial = compileTaskFrameContract({
      frame: frame({
        effects: {
          ...frame().effects,
          repositoryRead: true,
          repositoryWrite: "REQUIRED",
          webEvidence: true,
          verification: "STATIC",
        },
      }),
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    const availableTools = [{
      name: "web_search",
      description: "search",
      inputSchema: {},
      permissionLevel: "safe",
      source: "local" as const,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }];

    expect(selectToolsForCapabilityNegotiation(availableTools, initial).map((tool) => tool.name))
      .toContain("web_search");

    const web = negotiateCapabilities({
      contract: initial,
      decision: {
        type: "TOOL_CALL",
        toolName: "web_search",
        input: { query: "primary source" },
      },
      availableTools,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    expect(web.status).toBe("UPGRADED");
    if (web.status !== "UPGRADED") throw new Error("expected Web upgrade");
    expect(web.upgrade.contract).toMatchObject({
      kind: "AGENT_TASK",
      capabilities: { webAccess: true },
    });

    const write = negotiateCapabilities({
      contract: web.upgrade.contract,
      decision: {
        type: "APPLY_PATCH",
        patch: "diff --git a/a.ts b/a.ts",
        description: "implement",
      },
      availableTools,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    expect(write.status).toBe("UPGRADED");
    if (write.status !== "UPGRADED") throw new Error("expected write upgrade");
    expect(write.upgrade.contract).toMatchObject({
      kind: "AGENT_TASK",
      capabilities: {
        webAccess: true,
        repositoryWrite: true,
      },
    });
  });

  it("keeps explicit TaskFrame semantic constraints in the policy layer", () => {
    const taskFrame = frame();
    taskFrame.constraints.readOnly = true;
    const contract = compileTaskFrameContract({
      frame: taskFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "APPLY_PATCH",
        patch: "diff --git a/a b/a",
        description: "must be blocked",
      },
      availableTools: [],
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "DENIED",
      denial: {
        code: "CAPABILITY_ADAPTATION_DENIED",
        reason: expect.stringContaining("read-only"),
      },
    });
  });

  it("uses TaskFrame collaboration instead of rescanning the raw request", () => {
    const taskFrame = frame({
      effects: {
        ...frame().effects,
        delegation: true,
      },
      collaboration: {
        requirement: "REQUIRED",
        changeProposal: true,
        review: true,
        requestedAgents: 2,
      },
    });
    const contract = compileTaskFrameContract({
      frame: taskFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: true,
    });

    expect(resolveTaskCollaborationPolicy(contract)).toMatchObject({
      preference: "REQUIRED",
      requestedAgents: 2,
      requestsChangeProposal: true,
      requestsReview: true,
    });
  });

  it("enforces an explicit no-delegation TaskFrame constraint", () => {
    const taskFrame = frame();
    taskFrame.constraints.noDelegation = true;
    const contract = compileTaskFrameContract({
      frame: taskFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: true,
    });
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "DELEGATE",
        reason: "must be blocked",
        tasks: [{
          id: "researcher",
          role: "repository_researcher",
          objective: "inspect",
          focusPaths: [],
          access: "READ_ONLY",
          dependsOn: [],
        }],
      },
      availableTools: [],
      operatingMode: "EXECUTE",
      multiAgentAvailable: true,
    });

    expect(result).toMatchObject({
      status: "DENIED",
      denial: {
        code: "CAPABILITY_ADAPTATION_DENIED",
        reason: expect.stringContaining("prohibits delegation"),
      },
    });
  });

  it("discovers a requested destructive MCP tool but grants only that exact tool", () => {
    const taskFrame = frame({
      effects: {
        ...frame().effects,
        mcp: true,
      },
    });
    const contract = compileTaskFrameContract({
      frame: taskFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    const tools = [
      mcpSpec("calendar__list", false),
      mcpSpec("calendar__delete", true),
      mcpSpec("mail__send", true),
    ];

    expect(selectToolsForCapabilityNegotiation(tools, contract).map((tool) => tool.name))
      .toEqual(["calendar__list", "calendar__delete", "mail__send"]);

    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "TOOL_CALL",
        toolName: "calendar__delete",
        input: { id: "event-1" },
      },
      availableTools: tools,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "UPGRADED",
      upgrade: {
        granted: ["mcpAccess"],
        grantedTools: ["calendar__delete"],
        contract: {
          kind: "AGENT_TASK",
          capabilities: {
            mcpAccess: true,
            repositoryWrite: false,
            commandExecution: false,
          },
          mcpToolGrants: ["calendar__delete"],
        },
      },
    });
    if (result.status !== "UPGRADED") throw new Error("expected MCP tool grant");
    expect(isToolAllowedByTaskContract(tools[1], result.upgrade.contract)).toBe(true);
    expect(isToolAllowedByTaskContract(tools[0], result.upgrade.contract)).toBe(false);
    expect(isToolAllowedByTaskContract(tools[2], result.upgrade.contract)).toBe(false);
  });

  it("does not expose MCP tools when the TaskFrame explicitly prohibits them", () => {
    const taskFrame = frame({
      effects: {
        ...frame().effects,
        mcp: true,
      },
    });
    taskFrame.constraints.noMcp = true;
    const contract = compileTaskFrameContract({
      frame: taskFrame,
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });
    const destructive = mcpSpec("external__write", true);

    expect(selectToolsForCapabilityNegotiation([destructive], contract)).toEqual([]);
  });

  it("allows only an exact read-only MCP grant in Plan mode", () => {
    const taskFrame = frame({
      effects: {
        ...frame().effects,
        mcp: true,
      },
    });
    const contract = compileTaskFrameContract({
      frame: taskFrame,
      operatingMode: "PLAN",
      multiAgentAvailable: false,
    });
    const safe = mcpSpec("calendar__list", false);
    const destructive = mcpSpec("calendar__delete", true);

    expect(selectToolsForCapabilityNegotiation([safe, destructive], contract))
      .toEqual([safe]);
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "TOOL_CALL",
        toolName: safe.name,
        input: {},
      },
      availableTools: [safe, destructive],
      operatingMode: "PLAN",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "UPGRADED",
      upgrade: {
        grantedTools: ["calendar__list"],
        contract: {
          adaptationPolicy: "FIXED_READ_ONLY",
          mcpToolGrants: ["calendar__list"],
        },
      },
    });
  });

  it("creates a bootstrap contract without running legacy routing", () => {
    expect(createTaskFrameBootstrapContract()).toMatchObject({
      kind: "AGENT_TASK",
      executionStrategy: "ITERATIVE",
      adaptationPolicy: "ADAPTIVE",
    });
  });
});

function frame(overrides: Partial<TaskFrame> = {}): TaskFrame {
  const base: TaskFrame = {
    version: 1,
    objective: "Complete the current request.",
    target: "MIXED",
    productCapability: {
      act: "NONE",
      capabilityIds: [],
    },
    effects: {
      answer: true,
      repositoryRead: false,
      repositoryWrite: "NONE",
      webEvidence: false,
      knowledgeEvidence: false,
      commandExecution: false,
      verification: "NONE",
      delegation: false,
      mcp: false,
    },
    webEvidencePolicy: {
      profile: "ORDINARY",
      basis: "GENERAL_LOOKUP",
    },
    constraints: {
      readOnly: false,
      noWeb: false,
      noCommands: false,
      noDelegation: false,
      noMcp: false,
      requireCompleteFileRead: false,
    },
    collaboration: {
      requirement: "NONE",
      changeProposal: false,
      review: false,
      requestedAgents: null,
    },
    conversationEvidence: {
      purpose: "CONTEXT",
      requiresHistory: false,
      queries: [],
      includeRecentMessages: 8,
    },
    completionCriteria: ["Satisfy the request."],
    confidence: 0.95,
    ambiguities: [],
    rationale: "Semantic interpretation.",
  };
  return {
    ...base,
    ...overrides,
    effects: overrides.effects ?? base.effects,
    constraints: overrides.constraints ?? base.constraints,
  };
}

function mcpSpec(name: string, destructive: boolean) {
  return {
    name,
    description: name,
    inputSchema: {},
    permissionLevel: destructive ? "REVIEW" : "SAFE",
    source: "mcp" as const,
    annotations: {
      readOnlyHint: !destructive,
      destructiveHint: destructive,
      idempotentHint: !destructive,
      openWorldHint: true,
    },
  };
}
