import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOliviaService } from "../server.js";

test("管理页 HTML、CSS 与 JS 每次升级后都重新读取", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-admin-cache-"));
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(join(root, "信件往来_原始语料"), { recursive: true });
  const service = await createOliviaService({
    root,
    dataDir: join(root, "database"),
    worker: false,
    runMemoryRefresh: false,
    deferStorageRefresh: true,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = await service.listen(0, "127.0.0.1");

  for (const pathname of ["/admin", "/admin/styles.css", "/admin/app.js", "/admin/song-editor.js"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("cache-control"), "no-store", pathname);
  }
});
