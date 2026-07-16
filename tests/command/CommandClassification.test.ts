import { describe, expect, it } from "vitest";
import {
  classifyVerificationCommand,
  isTestCommand,
  isVerificationCommand,
  isVerificationRelevant,
  verificationLevelAtLeast,
} from "../../src/command/CommandClassification.js";

describe("CommandClassification", () => {
  it.each([
    "npm test",
    "pnpm run lint",
    "npx tsc --noEmit",
    "cargo check",
    "go vet ./...",
    "node --check src/app.js",
    "git diff --check",
    "python3 -m py_compile app.py",
    "c++ -fsyntax-only app.cpp",
  ])("recognizes verification command %s", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });

  it("keeps test commands as a narrower verification category", () => {
    expect(isTestCommand("npm test")).toBe(true);
    expect(isTestCommand("pnpm run lint")).toBe(false);
    expect(isVerificationCommand("pnpm run lint")).toBe(true);
  });

  it.each([
    "git diff",
    "git status",
    "node src/app.js",
    "echo done",
    "echo 'test passed'",
  ])("does not treat an arbitrary successful command as verification: %s", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });

  it("classifies verification strength instead of flattening every check", () => {
    expect(classifyVerificationCommand("git diff --check").level).toBe("DIFF_HYGIENE");
    expect(classifyVerificationCommand("node --check src/app.js").level).toBe("SYNTAX");
    expect(classifyVerificationCommand("npx tsc --noEmit src/app.ts").level).toBe("STATIC");
    expect(classifyVerificationCommand("npm test").level).toBe("TEST");
    expect(verificationLevelAtLeast("STATIC", "SYNTAX")).toBe(true);
    expect(verificationLevelAtLeast("DIFF_HYGIENE", "STATIC")).toBe(false);
  });

  it("tracks file-scoped checks separately from repository-wide checks", () => {
    const scoped = classifyVerificationCommand("node --check src/other.js");
    expect(scoped).toMatchObject({ repositoryWide: false, scopePaths: ["src/other.js"] });
    expect(isVerificationRelevant(scoped, ["src/app.js"])).toBe(false);
    expect(isVerificationRelevant(classifyVerificationCommand("npm test"), ["src/app.js"])).toBe(true);
  });
});
