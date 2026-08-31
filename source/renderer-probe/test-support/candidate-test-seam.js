import { validateRendererCandidateWithFs } from "../src/internal/candidate-core.js";

export async function validateRendererCandidateForTest(executablePath, fsAdapter) {
  return validateRendererCandidateWithFs(executablePath, fsAdapter);
}
