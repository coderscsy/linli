import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MidiStore } from "../midi/store.js";
import { createStorageMigrationManager } from "../storage-migration.js";

async function waitForPreview(manager, jobId, expectedState = "ready") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = manager.getPreview(jobId);
    if (current.state === expectedState) return current;
    if (current.state === "failed") assert.fail(current.error || "preview failed");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`preview did not reach ${expectedState}`);
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-storage-migration-"));
  const db = new DatabaseSync(join(root, "test.sqlite"));
  const mediaRoot = join(root, "media-index");
  const sourceRoot = join(root, "external-library");
  const targetRoot = join(root, "target-library");
  await Promise.all([mkdir(mediaRoot), mkdir(sourceRoot), mkdir(targetRoot)]);
  const store = new MidiStore({ db, root: mediaRoot, randomId: () => "song-1", now: () => 1_700_000_000 });
  const sourceVideo = join(sourceRoot, "official.mp4");
  await writeFile(sourceVideo, "OFFICIAL-VIDEO");
  const song = store.upsertUserSong({
    name: "官方成品",
    sourceKind: "official-import",
    videoPath: sourceVideo,
    videoByTodView: { TOD1730_NI_L: sourceVideo },
    durationUs: 12_000_000,
    contentHash: "d".repeat(64),
    externalRoot: sourceRoot,
  });
  const manager = createStorageMigrationManager({ db, midiStore: store, ...options });
  return {
    root, db, store, sourceRoot, sourceVideo, targetRoot, song, manager,
    async close() { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("迁移预览只读且没有明确确认时拒绝写入", async t => {
  const ctx = await fixture();
  t.after(() => ctx.close());

  const preview = await ctx.manager.preview({ targetRoot: ctx.targetRoot });
  assert.equal(preview.files, 1);
  assert.equal(preview.totalBytes, Buffer.byteLength("OFFICIAL-VIDEO"));
  await assert.rejects(stat(join(ctx.targetRoot, "OliviaSoul", "我的上传")), /ENOENT/u);
  await assert.rejects(ctx.manager.confirm({ token: preview.token, confirmed: false }), /明确确认/u);
  assert.equal(ctx.store.resolvePath(ctx.store.getUserSong(ctx.song.id).videoPath), ctx.sourceVideo);
  assert.equal(await readFile(ctx.sourceVideo, "utf8"), "OFFICIAL-VIDEO");
});

test("有效确认后经 staging 校验并切换数据库路径且保留来源", async t => {
  const ctx = await fixture();
  t.after(() => ctx.close());

  const preview = await ctx.manager.preview({ targetRoot: ctx.targetRoot });
  const result = await ctx.manager.confirm({ token: preview.token, confirmed: true });
  assert.equal(result.migrated, 1);
  const migratedPath = ctx.store.resolvePath(ctx.store.getUserSong(ctx.song.id).videoPath);
  assert.match(migratedPath, /target-library[\\/]OliviaSoul[\\/]我的上传/u);
  assert.equal(await readFile(migratedPath, "utf8"), "OFFICIAL-VIDEO");
  assert.equal(await readFile(ctx.sourceVideo, "utf8"), "OFFICIAL-VIDEO");
  assert.equal(ctx.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
});

test("过期令牌和空间不足均不复制或改写数据库", async t => {
  let now = 1_700_000_000;
  const ctx = await fixture({
    now: () => now,
    statfsImpl: async () => ({ bavail: 1n, bsize: 1n }),
  });
  t.after(() => ctx.close());

  const preview = await ctx.manager.preview({ targetRoot: ctx.targetRoot });
  assert.equal(preview.sufficient, false);
  await assert.rejects(ctx.manager.confirm({ token: preview.token, confirmed: true }), /空间不足/u);
  now += 601;
  await assert.rejects(ctx.manager.confirm({ token: preview.token, confirmed: true }), /过期/u);
  assert.equal(ctx.store.resolvePath(ctx.store.getUserSong(ctx.song.id).videoPath), ctx.sourceVideo);
});

test("后台预览立即返回并逐文件报告进度", async t => {
  let releaseHash;
  const hashGate = new Promise(resolve => { releaseHash = resolve; });
  const ctx = await fixture({
    hashFile: async path => {
      if (path.endsWith("official.mp4")) {
        await hashGate;
        return "a".repeat(64);
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    statfsImpl: async () => ({ bavail: 10_000_000n, bsize: 4096n }),
  });
  t.after(() => ctx.close());

  const started = ctx.manager.startPreview({ targetRoot: ctx.targetRoot });
  assert.equal(started.state, "scanning");
  assert.equal(ctx.manager.getPreview(started.jobId).processedFiles, 0);
  releaseHash();
  const ready = await waitForPreview(ctx.manager, started.jobId);
  assert.equal(ready.totalFiles, 1);
  assert.equal(ready.processedFiles, 1);
  assert.equal(ready.state, "ready");
  assert.match(ready.token, /\S/u);
});

test("取消预览不生成确认令牌且不改写作品路径", async t => {
  let releaseHash;
  const hashGate = new Promise(resolve => { releaseHash = resolve; });
  const ctx = await fixture({
    hashFile: async path => {
      if (path.endsWith("official.mp4")) {
        await hashGate;
        return "a".repeat(64);
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  t.after(() => ctx.close());

  const started = ctx.manager.startPreview({ targetRoot: ctx.targetRoot });
  assert.equal(ctx.manager.cancelPreview(started.jobId).state, "cancelled");
  releaseHash();
  await new Promise(resolve => setTimeout(resolve, 20));
  const cancelled = ctx.manager.getPreview(started.jobId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.token, null);
  assert.equal(ctx.store.resolvePath(ctx.store.getUserSong(ctx.song.id).videoPath), ctx.sourceVideo);
});
