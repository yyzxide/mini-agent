import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const content = await fs.readFile(cliEntry, "utf8");

if (!content.startsWith("#!/usr/bin/env node\n")) {
  throw new Error(`Compiled CLI entry is missing its Node shebang: ${cliEntry}`);
}

if (process.platform !== "win32") {
  await fs.chmod(cliEntry, 0o755);
}
