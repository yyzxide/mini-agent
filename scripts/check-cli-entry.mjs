import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "dist", "cli", "index.js");
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const stat = await fs.stat(cliEntry);
const content = await fs.readFile(cliEntry, "utf8");

if (!stat.isFile()) {
  throw new Error(`Compiled CLI entry is not a regular file: ${cliEntry}`);
}
if (!content.startsWith("#!/usr/bin/env node\n")) {
  throw new Error(`Compiled CLI entry is missing its Node shebang: ${cliEntry}`);
}
if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
  throw new Error(`Compiled CLI entry is not executable: ${cliEntry}`);
}

const command = process.platform === "win32" ? process.execPath : cliEntry;
const args = process.platform === "win32"
  ? [cliEntry, "--version"]
  : ["--version"];
const { stdout, stderr, exitCode } = await runWithFileBackedOutput(command, args);

if (exitCode !== 0) {
  throw new Error(
    `Compiled CLI exited with ${String(exitCode)}: ${stderr.trim() || "(no stderr)"}`,
  );
}
if (stdout.trim() !== packageJson.version) {
  throw new Error(
    `Compiled CLI reported version ${JSON.stringify(stdout.trim())}; expected ${JSON.stringify(packageJson.version)}`,
  );
}

process.stdout.write(
  `CLI entry check passed: executable dist/cli/index.js reports ${packageJson.version}.\n`,
);

async function runWithFileBackedOutput(command, args) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-cli-check-"));
  const stdoutPath = path.join(temporaryDirectory, "stdout.txt");
  const stderrPath = path.join(temporaryDirectory, "stderr.txt");
  const stdoutHandle = await fs.open(stdoutPath, "w");
  const stderrHandle = await fs.open(stderrPath, "w");

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: projectRoot,
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
        windowsHide: true,
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Compiled CLI entry timed out after 10000ms"));
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (signal) {
          reject(new Error(`Compiled CLI entry exited from signal ${signal}`));
          return;
        }
        resolve(code);
      });
    });
    await Promise.all([stdoutHandle.sync(), stderrHandle.sync()]);
    return {
      exitCode,
      stdout: await fs.readFile(stdoutPath, "utf8"),
      stderr: await fs.readFile(stderrPath, "utf8"),
    };
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
