import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePlacementAdvisor } from "../../src/context/FilePlacementAdvisor.js";
import { RepoStateAnalyzer } from "../../src/context/RepoStateAnalyzer.js";

const execFileAsync = promisify(execFile);

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-file-placement-"));
  await execFileAsync("git", ["init"], { cwd: repoPath });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe("FilePlacementAdvisor", () => {
  it("prefers a static-web directory for standalone browser demos", async () => {
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "demo" }, null, 2), "utf8");
    await fs.mkdir(path.join(repoPath, "public"), { recursive: true });

    const repoState = await new RepoStateAnalyzer({ repoPath }).analyze();
    const advice = await new FilePlacementAdvisor({ repoPath }).advise("帮我写个2048游戏吧", repoState);

    expect(advice.inferredLanguage).toBe("HTML");
    expect(advice.artifactKind).toBe("standalone_demo");
    expect(advice.suggestedPaths[0]).toBe("public/game_2048.html");
  });

  it("falls back to repository root for standalone C++ examples in a generic repo", async () => {
    const repoState = await new RepoStateAnalyzer({ repoPath }).analyze();
    const advice = await new FilePlacementAdvisor({ repoPath }).advise("写一个两数之和的C++代码", repoState);

    expect(advice.inferredLanguage).toBe("C++");
    expect(advice.suggestedPaths).toContain("two_sum.cpp");
  });

  it("uses recognizable algorithm names for common follow-up problems", async () => {
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "ts-demo" }, null, 2), "utf8");
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export {};\n", "utf8");

    const repoState = await new RepoStateAnalyzer({ repoPath }).analyze();
    const advice = await new FilePlacementAdvisor({ repoPath }).advise("数据流的中位数呢", repoState);

    expect(advice.inferredLanguage).toBe("TypeScript");
    expect(advice.suggestedPaths[0]).toBe("src/median_finder.ts");
  });

  it("places Chinese documentation requests in the existing localized docs directory", async () => {
    await fs.mkdir(path.join(repoPath, "docs", "zh-CN"), { recursive: true });
    const repoState = await new RepoStateAnalyzer({ repoPath }).analyze();

    const advice = await new FilePlacementAdvisor({ repoPath }).advise(
      "那你帮我写一个自身的设计文档",
      repoState,
    );

    expect(advice.inferredLanguage).toBe("Markdown");
    expect(advice.artifactKind).toBe("documentation");
    expect(advice.suggestedPaths[0]).toBe("docs/zh-CN/self_structure_design.md");
  });

  it("keeps document-named implementation features in source files", async () => {
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "ts-demo" }), "utf8");
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export {};\n", "utf8");
    const repoState = await new RepoStateAnalyzer({ repoPath }).analyze();

    for (const goal of ["创建一个报告导出功能", "写 README 解析器"]) {
      const advice = await new FilePlacementAdvisor({ repoPath }).advise(goal, repoState);
      expect(advice.artifactKind).toBe("source");
      expect(advice.inferredLanguage).toBe("TypeScript");
      expect(advice.suggestedPaths[0]).toMatch(/^src\/.+\.ts$/);
    }
  });
});
