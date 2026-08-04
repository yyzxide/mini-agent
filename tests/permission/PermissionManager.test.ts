import { describe, expect, it } from "vitest";
import { PermissionLevel } from "../../src/permission/PermissionLevel.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";

describe("PermissionManager", () => {
  it("allows SAFE actions automatically", async () => {
    const manager = new PermissionManager();

    const decision = await manager.check({
      level: PermissionLevel.SAFE,
      action: "read_file",
      nonInteractive: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("AUTO");
  });

  it("rejects DANGEROUS actions in non-interactive mode", async () => {
    const manager = new PermissionManager();

    const decision = await manager.check({
      level: PermissionLevel.DANGEROUS,
      action: "run_command",
      command: "echo hello",
      nonInteractive: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("USER_REJECTED");
  });

  it("allows ordinary commands with autoApprove", async () => {
    const manager = new PermissionManager();

    const decision = await manager.check({
      level: PermissionLevel.DANGEROUS,
      action: "run_command",
      command: "echo hello",
      nonInteractive: true,
      autoApprove: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("AUTO");
  });

  it("requires explicit approval for high-risk shell commands", async () => {
    const manager = new PermissionManager();

    const decision = await manager.check({
      level: PermissionLevel.DANGEROUS,
      action: "run_shell_command",
      command: "echo hello",
      nonInteractive: true,
      autoApprove: true,
      requiresExplicitApproval: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("USER_REJECTED");
    expect(decision.reason).toContain("explicit approval");
  });

  it("accepts the numbered yes option shown by the prompt", async () => {
    let prompt = "";
    const manager = new PermissionManager({
      prompt: async (message) => {
        prompt = message;
        return "1";
      },
    });

    const decision = await manager.check({
      level: PermissionLevel.REVIEW,
      action: "external_write",
    });

    expect(prompt).toContain("1. yes");
    expect(decision).toMatchObject({ allowed: true, mode: "USER_APPROVED" });
  });

  it("rejects the numbered no option shown by the prompt", async () => {
    const manager = new PermissionManager({ prompt: async () => "2" });

    const decision = await manager.check({
      level: PermissionLevel.REVIEW,
      action: "external_write",
    });

    expect(decision).toMatchObject({ allowed: false, mode: "USER_REJECTED" });
  });

  it("blocks sudo commands", async () => {
    const manager = new PermissionManager();

    const decision = await manager.check({
      level: PermissionLevel.DANGEROUS,
      action: "run_command",
      command: "sudo ls",
      nonInteractive: true,
      autoApprove: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("BLOCKED");
    expect(decision.reason).toContain("sudo");
  });

  it("blocks rm -rf / commands", async () => {
    const manager = new PermissionManager();

    const decision = await manager.check({
      level: PermissionLevel.DANGEROUS,
      action: "run_command",
      command: "rm -rf /",
      nonInteractive: true,
      autoApprove: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("BLOCKED");
    expect(decision.reason).toContain("rm -rf /");
  });
});
