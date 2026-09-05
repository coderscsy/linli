import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("uninstall legacy adoption recognizes the current v31 FE locale patch", async () => {
  const source = await readFile(new URL("../desktop/uninstall-restore.js", import.meta.url), "utf8");
  assert.match(source, /allowKnownFeLocale:[\s\S]{0,180}\["v29",\s*"v30",\s*"v31"\]\.includes/u);
});
