// Test-only dependency seam. The production cli.js exports only runCli(args).
import {
  createProductionCliDependencies,
  resolveTemporaryTestLayout,
  runCliCore,
} from "../../src/internal/cli-core.js";

export async function runCliForTest(args, {
  dependencies = {},
  now,
  requiredDrive,
  stderr,
  stdout,
} = {}) {
  const production = createProductionCliDependencies();
  const testDependencies = {
    ...production,
    ...dependencies,
    now: now ?? production.now,
    resolveLayout: dataRoot => resolveTemporaryTestLayout(dataRoot, requiredDrive),
    stderr: stderr ?? production.stderr,
    stdout: stdout ?? production.stdout,
  };
  return runCliCore(args, testDependencies);
}
