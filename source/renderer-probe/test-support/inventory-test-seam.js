// Test-only adapter seam. Production callers must import src/inventory.js instead.
import { scanRendererInventoryWithFsForTest } from "../src/inventory.js";

export async function scanRendererInventoryForTest(options, fsAdapter) {
  return scanRendererInventoryWithFsForTest(options, fsAdapter);
}
