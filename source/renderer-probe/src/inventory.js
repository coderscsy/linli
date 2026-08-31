import { lstat, opendir, readFile, realpath } from "node:fs/promises";

import { scanRendererInventoryWithFs } from "./internal/inventory-core.js";

const DEFAULT_FS = { lstat, opendir, readFile, realpath };

export async function scanRendererInventory({ roots, steamAppsRoot, marker }) {
  return scanRendererInventoryWithFs({ roots, steamAppsRoot, marker }, DEFAULT_FS);
}
