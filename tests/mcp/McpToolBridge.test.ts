import { describe, expect, it } from "vitest";
import { McpServerConfigSchema } from "../../src/mcp/McpTypes.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("MCP tool bridge", () => {
  it("exports local tool descriptors with safety annotations", () => {
    const descriptors = createDefaultToolRegistry().listMcpToolDescriptors();

    expect(descriptors).toContainEqual(expect.objectContaining({
      name: "fetch_url",
      annotations: expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      }),
      metadata: expect.objectContaining({
        source: "local",
        category: "web",
        permissionLevel: "REVIEW",
      }),
    }));
  });

  it("validates MCP server config shape", () => {
    expect(McpServerConfigSchema.parse({
      name: "filesystem",
      command: "mcp-server-filesystem",
      args: ["."],
    })).toMatchObject({
      name: "filesystem",
      command: "mcp-server-filesystem",
      args: ["."],
      enabled: true,
    });

    expect(() => McpServerConfigSchema.parse({ name: "broken" })).toThrow();
  });
});
