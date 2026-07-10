import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore, formatSkillsForContext } from "../../src/skills/SkillStore.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-skills-"));
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("SkillStore", () => {
  it("discovers repository and local skills with CRLF-compatible frontmatter", async () => {
    await writeSkill(path.join(repoPath, "skills", "testing", "SKILL.md"), [
      "---", "name: testing", "description: Test TypeScript changes", "triggers: test, vitest", "---", "", "Run targeted tests, then the full suite.",
    ].join("\r\n"));
    const store = new SkillStore({ repoPath });
    await store.create("review", "Review code changes");

    const skills = await store.list();
    expect(skills.map((skill) => skill.name)).toEqual(["review", "testing"]);
    expect(skills.find((skill) => skill.name === "testing")?.source).toBe("repository");
  });

  it("selects explicit and trigger-matched skills deterministically", async () => {
    await writeSkill(path.join(repoPath, "skills", "testing", "SKILL.md"), [
      "---", "name: testing", "description: Test changes", "triggers: vitest, regression", "---", "", "Always run regression tests.",
    ].join("\n"));
    await writeSkill(path.join(repoPath, "skills", "docs", "SKILL.md"), [
      "---", "name: docs", "description: Update documentation", "triggers: readme, documentation", "---", "", "Keep docs synchronized.",
    ].join("\n"));

    const store = new SkillStore({ repoPath });
    await expect(store.select("run vitest regression", 1)).resolves.toMatchObject([{ name: "testing" }]);
    await expect(store.select("use $docs for this", 1)).resolves.toMatchObject([{ name: "docs" }]);
  });

  it("reports invalid skills without breaking valid discovery", async () => {
    await writeSkill(path.join(repoPath, "skills", "broken", "SKILL.md"), "# no metadata\n");
    const results = await new SkillStore({ repoPath }).validateAll();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ valid: false });
    expect(results[0]?.errors.length).toBeGreaterThan(0);
  });

  it("prefers versioned repository skills over same-name local skills", async () => {
    const store = new SkillStore({ repoPath });
    await store.create("testing", "Local testing workflow");
    await writeSkill(path.join(repoPath, "skills", "testing", "SKILL.md"), [
      "---", "name: testing", "description: Repository testing workflow", "triggers: test", "---", "", "Repository instructions.",
    ].join("\n"));
    await expect(store.get("testing")).resolves.toMatchObject({
      source: "repository",
      description: "Repository testing workflow",
    });
  });

  it("formats selected instructions with precedence guidance", async () => {
    const skill = await new SkillStore({ repoPath }).create("testing", "Test changes");
    const context = formatSkillsForContext([skill]);
    expect(context).toContain("current user instructions");
    expect(context).toContain("Skill: testing");
  });
});

async function writeSkill(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
