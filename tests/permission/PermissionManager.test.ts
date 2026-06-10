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
