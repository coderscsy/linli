import { validateRendererCandidateWithFs } from "../../src/internal/candidate-core.js";

export async function validateRendererCandidateForTest(executablePath, fsAdapter, limits) {
  return validateRendererCandidateWithFs(executablePath, fsAdapter, limits);
}
