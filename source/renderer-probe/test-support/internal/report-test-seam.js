// Test-only filesystem seam. Production report APIs never accept an adapter.
import { DEFAULT_TRANSACTION_FS, writeStage1ABundleTransaction } from "../../src/internal/report-transaction.js";

export async function writeStage1ABundleForTest(layout, bundle, overrides = {}) {
  return writeStage1ABundleTransaction(layout, bundle, { ...DEFAULT_TRANSACTION_FS, ...overrides });
}
