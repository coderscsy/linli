import { validateRendererCandidateWithFs } from "./internal/candidate-core.js";

export async function validateRendererCandidate(executablePath) {
  return validateRendererCandidateWithFs(executablePath);
}
