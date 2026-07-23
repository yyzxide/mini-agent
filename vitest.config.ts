import { defineConfig } from "vitest/config";
import { ProcessIntegrationFirstSequencer } from "./tests/TestSequencer.js";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Process-spawning and MCP integration tests share constrained CI/sandbox
    // resources; serial workers keep their stdout pipes and child lifecycles deterministic.
    maxWorkers: 1,
    setupFiles: ["tests/setup.ts"],
    sequence: {
      sequencer: ProcessIntegrationFirstSequencer,
    },
  },
});
