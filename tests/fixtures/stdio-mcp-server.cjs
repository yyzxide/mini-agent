const fs = require("node:fs");
const readline = require("node:readline");

const input = readline.createInterface({ input: process.stdin });

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  let result = {};
  if (message.method === "initialize") {
    result = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  }
  if (message.method === "tools/list") {
    result = {
      tools: [{
        name: "echo",
        description: "Echo input",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        annotations: { readOnlyHint: true },
      }],
    };
  }
  if (message.method === "tools/call") {
    const text = message.params.arguments.text;
    result = {
      content: [{ type: "text", text }],
      structuredContent: { echo: text },
    };
  }

  fs.writeSync(1, `${JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result,
  })}\n`);
});
