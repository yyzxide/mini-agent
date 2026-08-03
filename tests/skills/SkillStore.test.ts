import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore, formatSkillCatalogForContext, formatSkillsForContext } from "../../src/skills/SkillStore.js";
import { createDefaultToolRegistry } from "../../src/tools/ToolRegistry.js";

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

  it("parses inline YAML-style trigger lists", async () => {
    await writeSkill(path.join(repoPath, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "description: Demo workflow", "triggers: [\"demo\", \"smoke\"]", "---", "", "Follow the demo workflow.",
    ].join("\n"));

    const store = new SkillStore({ repoPath });
    await expect(store.select("run smoke check", 1)).resolves.toMatchObject([{ name: "demo" }]);
    await expect(store.matchExactActivation("smoke")).resolves.toMatchObject({ name: "demo" });
    await expect(store.matchExactActivation("$demo")).resolves.toMatchObject({ name: "demo" });
    await expect(store.matchExactActivation("run smoke check")).resolves.toBeUndefined();
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
    expect(formatSkillCatalogForContext([skill])).toContain("Use skill_read");
  });

  it("discovers and progressively reads bundled skill resources", async () => {
    const skillFile = path.join(repoPath, "skills", "testing", "SKILL.md");
    await writeSkill(skillFile, [
      "---", "name: testing", "description: Test changes", "triggers: tests", "---", "", "Read references/checks.md.",
    ].join("\n"));
    await fs.mkdir(path.join(repoPath, "skills", "testing", "references"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "skills", "testing", "references", "checks.md"), "one\ntwo\nthree\n", "utf8");

    const store = new SkillStore({ repoPath });
    await expect(store.get("testing")).resolves.toMatchObject({ resources: ["references/checks.md"] });
    await expect(store.read("testing", { resource: "references/checks.md", maxLines: 2 })).resolves.toMatchObject({
      content: "one\ntwo",
      hasMore: true,
      nextStartLine: 3,
    });
    const result = await createDefaultToolRegistry().execute("skill_read", {
      name: "testing",
      resource: "references/checks.md",
      startLine: 3,
      maxLines: 2,
    }, { repoPath });
    expect(result).toMatchObject({ success: true, data: { content: "three\n", hasMore: false } });
  });

  it("does not advertise binary or oversized bundled files as readable skill resources", async () => {
    const skillFile = path.join(repoPath, "skills", "testing", "SKILL.md");
    await writeSkill(skillFile, [
      "---", "name: testing", "description: Test changes", "triggers: tests", "---", "", "Read text resources only.",
    ].join("\n"));
    await fs.writeFile(path.join(repoPath, "skills", "testing", "image.png"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(repoPath, "skills", "testing", "large.txt"), "x".repeat(128_001), "utf8");

    await expect(new SkillStore({ repoPath }).get("testing")).resolves.toMatchObject({ resources: [] });
  });
});

async function writeSkill(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
