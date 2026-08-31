// Test-only adapter seam. The internal module is not a production package API.
import { scanRendererInventoryWithFs } from "../src/internal/inventory-core.js";

export async function scanRendererInventoryForTest(options, fsAdapter) {
  return scanRendererInventoryWithFs(options, fsAdapter);
}
