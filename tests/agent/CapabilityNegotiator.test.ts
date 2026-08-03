import { describe, expect, it } from "vitest";
import {
  negotiateCapabilities,
  selectToolsForCapabilityNegotiation,
} from "../../src/agent/CapabilityNegotiator.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";
import { createTestTaskContract } from "../helpers/TaskFrameContract.js";

describe("CapabilityNegotiator", () => {
  it("treats a model patch action as a capability request", () => {
    const contract = answerOnlyContract("继续优化当前实现");
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "APPLY_PATCH",
        description: "Improve the implementation",
        patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
      },
      availableTools: createDefaultToolRegistry().listSpecs(),
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "UPGRADED",
      upgrade: {
        previousKind: "AGENT_TASK",
        contract: {
          kind: "AGENT_TASK",
          capabilities: {
            repositoryWrite: true,
            commandExecution: false,
          },
        },
        granted: ["repositoryWrite"],
      },
    });
  });

  it("makes requestable read-only tools visible before their capability is granted", () => {
    const contract = answerOnlyContract("请判断需要哪些证据");
    const names = selectToolsForCapabilityNegotiation(
      createDefaultToolRegistry().listSpecs(),
      contract,
    ).map((tool) => tool.name);

    expect(contract.capabilities.webAccess).toBe(false);
    expect(contract.capabilities.knowledgeAccess).toBe(false);
    expect(names).toEqual(expect.arrayContaining([
      "read_file",
      "web_search",
      "fetch_url",
      "knowledge_search",
    ]));
    expect(names).not.toContain("apply_patch");
  });

  it("never exposes the internal patch executor as a TOOL_CALL even after write authorization", () => {
    const contract = createTestTaskContract({
      objective: "Modify a repository file",
      target: "REPOSITORY",
      effects: { repositoryRead: true, repositoryWrite: "REQUIRED" },
    });
    const writeAuthorized = {
      ...contract,
      capabilities: { ...contract.capabilities, repositoryWrite: true },
    };
    const names = selectToolsForCapabilityNegotiation(
      createDefaultToolRegistry().listSpecs(),
      writeAuthorized,
    ).map((tool) => tool.name);

    expect(writeAuthorized.capabilities.repositoryWrite).toBe(true);
    expect(names).not.toContain("apply_patch");
    expect(names).toContain("verify_file");
  });

  it("upgrades an answer-only contract when the model selects a Web tool", () => {
    const contract = answerOnlyContract("需要核实一个外部事实");
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "TOOL_CALL",
        toolName: "web_search",
        input: { query: "external fact" },
        reason: "Obtain current evidence",
      },
      availableTools: createDefaultToolRegistry().listSpecs(),
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "UPGRADED",
      upgrade: {
        contract: {
          kind: "AGENT_TASK",
          capabilities: { webAccess: true },
          evidence: { webSearch: true, webCitation: true },
        },
        action: "TOOL_CALL",
        granted: ["webAccess"],
      },
    });
  });

  it("preserves gathered Web capability and evidence requirements when upgrading to a patch", () => {
    const userGoal = "先联网研究，再优化当前实现";
    const base = createTestTaskContract({
      objective: userGoal,
      target: "MIXED",
      effects: { webEvidence: true, repositoryWrite: "REQUIRED" },
    });
    const contract = {
      ...base,
      capabilities: { ...base.capabilities, webAccess: true },
    };
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "APPLY_PATCH",
        description: "Apply the research-backed optimization",
        patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
      },
      availableTools: createDefaultToolRegistry().listSpecs(),
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "UPGRADED",
      upgrade: {
        contract: {
          kind: "AGENT_TASK",
          capabilities: {
            webAccess: true,
            repositoryWrite: true,
          },
          evidence: {
            webSearch: true,
            webCitation: true,
          },
        },
      },
    });
  });

  it("keeps explicit read-only contracts as an immutable boundary", () => {
    const contract = createTestTaskContract({
      objective: "只分析 demo.txt，不要修改文件",
      target: "REPOSITORY",
      effects: { repositoryRead: true },
      constraints: { readOnly: true, noCommands: true },
    });
    const result = negotiateCapabilities({
      contract,
      decision: {
        type: "RUN_COMMAND",
        executable: "npm",
        args: ["test"],
        description: "Attempt command",
      },
      availableTools: createDefaultToolRegistry().listSpecs(),
      operatingMode: "EXECUTE",
      multiAgentAvailable: false,
    });

    expect(result).toMatchObject({
      status: "DENIED",
      denial: { code: "CAPABILITY_ADAPTATION_DENIED" },
    });
  });
});

function answerOnlyContract(userGoal: string) {
  return createTestTaskContract({
    objective: userGoal,
  });
}
