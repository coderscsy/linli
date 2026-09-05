import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("storage paths are hidden behind a collapsed disclosure by default", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  const disclosure = html.match(/<details[^>]*id="storagePathDetails"[^>]*>([\s\S]*?)<\/details>/u);
  assert.ok(disclosure, "storagePathDetails disclosure should exist");
  assert.doesNotMatch(disclosure[0], /<details[^>]*\sopen(?:\s|>)/u);
  assert.match(disclosure[0], /<summary[^>]*>查看本机路径<\/summary>/u);
  assert.match(disclosure[1], /id="storageConfiguredPath"/u);
  assert.match(disclosure[1], /id="storageActivePath"/u);
  assert.match(disclosure[1], /id="storageManagedPath"/u);
});
