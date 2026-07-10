import { formatSkillsForContext, SkillStore } from "./SkillStore.js";

export class SkillContextService {
  private readonly store: SkillStore;

  constructor(options: { repoPath: string }) {
    this.store = new SkillStore(options);
  }

  async build(query: string, limit = 3): Promise<string> {
    return formatSkillsForContext(await this.store.select(query, limit));
  }
}

export function appendSkillContext(currentContext: string, skillContext: string): string {
  if (!skillContext || skillContext === "(none selected)") {
    return currentContext;
  }
  return [currentContext, "", "Active skills:", skillContext].join("\n");
}
