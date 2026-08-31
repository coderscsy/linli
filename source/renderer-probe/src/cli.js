import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductionCliDependencies, runCliCore } from "./internal/cli-core.js";

export async function runCli(args) {
  return runCliCore(args, createProductionCliDependencies());
}

const executablePath = process.argv[1] ? resolve(process.argv[1]) : "";
if (executablePath && executablePath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
