import { describe, expect, it } from "vitest";
import { classifyErrorText, hasHighConfidenceDiagnostic } from "../../src/diagnostics/ErrorClassifier.js";

describe("ErrorClassifier", () => {
  it("classifies package-manager missing package.json errors as wrong working directory", () => {
    const diagnostic = classifyErrorText({
      repoPath: "/home/sid/miniagent/mini-coding-agent",
      text: [
        "sid@ubuntu:/home/sid/miniagent$ npm run guess",
        "npm error code ENOENT",
        "npm error path /home/sid/miniagent/package.json",
        "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/home/sid/miniagent/package.json'",
      ].join("\n"),
    });

    expect(diagnostic).toMatchObject({
      category: "WRONG_WORKING_DIRECTORY",
      confidence: "high",
      metadata: {
        attemptedDirectory: "/home/sid/miniagent",
        repoPath: "/home/sid/miniagent/mini-coding-agent",
        packageManager: "npm",
        scriptName: "guess",
      },
    });
    expect(diagnostic?.suggestedCommands).toEqual(expect.arrayContaining([
      "cd /home/sid/miniagent/mini-coding-agent",
      "npm run guess",
      "npm --prefix /home/sid/miniagent/mini-coding-agent run guess",
    ]));
  });

  it("detects command-not-found errors", () => {
    const diagnostic = classifyErrorText({
      repoPath: "/repo",
      text: "bash: mini-agent: command not found",
    });

    expect(diagnostic).toMatchObject({
      category: "COMMAND_NOT_FOUND",
      confidence: "high",
      metadata: {
        command: "mini-agent",
      },
    });
  });

  it("detects port-in-use errors", () => {
    const diagnostic = classifyErrorText({
      repoPath: "/repo",
      text: "Web server failed to start. Port 8080 was already in use.",
    });

    expect(diagnostic).toMatchObject({
      category: "PORT_IN_USE",
      confidence: "high",
      metadata: {
        port: 8080,
      },
    });
  });

  it("detects refused local connections", () => {
    const diagnostic = classifyErrorText({
      repoPath: "/repo",
      text: "connect ECONNREFUSED 127.0.0.1:3308",
    });

    expect(diagnostic).toMatchObject({
      category: "CONNECTION_REFUSED",
      confidence: "high",
      metadata: {
        target: "127.0.0.1:3308",
      },
    });
  });

  it("returns undefined for ordinary chat", () => {
    expect(classifyErrorText({ repoPath: "/repo", text: "你好啊" })).toBeUndefined();
    expect(hasHighConfidenceDiagnostic({ repoPath: "/repo", text: "你好啊" })).toBe(false);
  });
});
