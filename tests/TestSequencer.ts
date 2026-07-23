import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

const PROCESS_INTEGRATION_FILES = [
  "/tests/command/CommandRunner.test.ts",
  "/tests/mcp/McpToolBridge.test.ts",
];

export class ProcessIntegrationFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const defaultOrder = await super.sort(files);
    return defaultOrder.sort((left, right) => priority(left.moduleId) - priority(right.moduleId));
  }
}

function priority(moduleId: string): number {
  const normalized = moduleId.replaceAll("\\", "/");
  const index = PROCESS_INTEGRATION_FILES.findIndex((suffix) => normalized.endsWith(suffix));
  return index === -1 ? PROCESS_INTEGRATION_FILES.length : index;
}
