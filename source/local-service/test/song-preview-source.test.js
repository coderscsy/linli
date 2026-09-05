import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createSongPreviewResolver } from "../midi/song-preview-source.js";
import { scanPerformanceLibrary } from "../midi/library-importer.js";

const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, { legacy = true, resolverOptions = {} } = {}) {
  const testRoot = "I:\\OliviaSoulData\\Tools\\temp";
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "olivia-preview-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, "library");
  await mkdir(join(library, "midi_work"), { recursive: true });
  const contents = { DEFAULT: "original day", ALT_2: "original evening", ALT_3: "original night" };
  const variants = {};
  for (const [key, body] of Object.entries(contents)) {
    variants[key] = `midi_work/${hash(body).slice(0, 12)}.mp4`;
    await writeFile(join(library, variants[key]), body);
  }
  const contentHash = legacy ? hash(contents.DEFAULT) : hash(Object.entries(contents)
    .sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, body]) => `${key}\0${hash(body)}\0`).join(""));
  const stale = Object.fromEntries(Object.keys(variants).map(key => [key, join(root, ".faststart-cache", contentHash, key + ".mp4")]));
  const song = { id: "stable-work", name: "Custom name", originalName: "Original", sourceKind: "import", contentHash,
    videoPath: stale.DEFAULT, videoByTodView: stale, timeOfDayMapping: { TOD12: "ALT_3" } };
  const manifest = async (patch = {}) => writeFile(join(library, "library.json"), JSON.stringify({ songs: [{ name: "Original", variants, ...patch }] }));
  await manifest();
  let selectedRoot = library;
  const resolvePreview = createSongPreviewResolver({
    resolvePath: path => path,
    getLibraryRoot: () => selectedRoot,
    ...resolverOptions,
  });
  return { root, library, variants, contents, song, manifest, resolvePreview, setRoot: value => { selectedRoot = value; } };
}

test("missing legacy cache previews exact original variants without changing names, mappings, files or DB", async t => {
  const f = await fixture(t), before = structuredClone(f.song);
  for (const key of Object.keys(f.variants))
    assert.equal(await f.resolvePreview(f.song, key), join(f.library, f.variants[key]));
  assert.deepEqual(f.song, before);
});
test("current multi-variant content hashes recover the same work", async t => {
  const f = await fixture(t, { legacy: false });
  assert.equal(await f.resolvePreview(f.song, "ALT_3"), join(f.library, f.variants.ALT_3));
});
test("registered existing file wins without scanning an unrelated library", async t => {
  const f = await fixture(t);
  const actual = join(f.library, f.variants.DEFAULT);
  f.song.videoByTodView.DEFAULT = actual;
  f.setRoot(join(f.root, "missing-library"));
  assert.equal(await f.resolvePreview(f.song, "DEFAULT"), actual);
});
test("original-source recovery bypasses a present legacy faststart cache and returns the verified source clip", async t => {
  const f = await fixture(t);
  const cached = f.song.videoByTodView.DEFAULT;
  await mkdir(join(f.root, ".faststart-cache", f.song.contentHash), { recursive: true });
  await writeFile(cached, "transformed cache bytes");
  assert.equal(
    await f.resolvePreview(f.song, "DEFAULT", { originalSource: true }),
    join(f.library, f.variants.DEFAULT),
  );
});
test("source matching considers the current display name when the original title is stale", async t => {
  const f = await fixture(t);
  f.song.originalName = "Historic source title";
  f.song.name = "Original";
  assert.equal(await f.resolvePreview(f.song, "ALT_2"), join(f.library, f.variants.ALT_2));
});
test("same title or generic filename is not enough to bind a different work", async t => {
  const f = await fixture(t);
  await writeFile(join(f.library, f.variants.DEFAULT), "wrong work");
  await assert.rejects(f.resolvePreview(f.song, "ALT_2"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
});
test("unknown variants, missing sources and traversal never substitute another clip", async t => {
  const f = await fixture(t);
  await assert.rejects(f.resolvePreview(f.song, "MISSING"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
  await f.manifest({ variants: { ...f.variants, ALT_2: "../outside.mp4" } });
  await writeFile(join(f.root, "outside.mp4"), "outside");
  await assert.rejects(f.resolvePreview(f.song, "ALT_2"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
});
test("changing the configured root cannot reuse a previously resolved clip", async t => {
  const f = await fixture(t);
  await f.resolvePreview(f.song, "DEFAULT");
  f.setRoot(join(f.root, "missing-library"));
  await assert.rejects(f.resolvePreview(f.song, "ALT_2"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
});
test("a replaced source invalidates its cached fingerprint", async t => {
  const f = await fixture(t);
  await f.resolvePreview(f.song, "DEFAULT");
  await writeFile(join(f.library, f.variants.DEFAULT), "replacement with a different identity");
  await assert.rejects(f.resolvePreview(f.song, "ALT_2"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
});
test("a manifest path through a directory link cannot escape the configured source", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "clip.mp4"), "outside media");
  try {
    await symlink(outside, join(f.library, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EISDIR", "ENOTSUP"].includes(error.code)) throw error;
    t.skip(`Test volume does not support directory links (${error.code})`);
    return;
  }
  await f.manifest({ variants: { ...f.variants, ALT_2: "linked/clip.mp4" } });
  await assert.rejects(f.resolvePreview(f.song, "ALT_2"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
});

test("concurrent cold previews share bounded index and hash work, then revalidate signatures after five seconds", async t => {
  let scans = 0;
  let hashes = 0;
  let clock = 1_000;
  const f = await fixture(t, {
    legacy: false,
    resolverOptions: {
      now: () => clock,
      scanLibrary: async root => {
        scans += 1;
        return scanPerformanceLibrary(root);
      },
      hashFile: async path => {
        hashes += 1;
        return hash(await readFile(path));
      },
    },
  });

  const paths = await Promise.all(Object.keys(f.variants).map(key => f.resolvePreview(f.song, key)));
  assert.deepEqual(paths.sort(), Object.values(f.variants).map(path => join(f.library, path)).sort());
  assert.equal(scans, 1);
  assert.equal(hashes, 3);

  clock += 5_001;
  await f.resolvePreview(f.song, "DEFAULT");
  assert.equal(scans, 1, "unchanged root and manifest use the warm index after signature revalidation");
  assert.equal(hashes, 3);

  clock += 300_001;
  await f.resolvePreview(f.song, "ALT_2");
  assert.equal(scans, 2, "the bounded index is rebuilt once after its five-minute maximum age");

  await f.manifest({ variants: { ...f.variants, ALT_2: "missing.mp4" } });
  clock += 5_001;
  await assert.rejects(f.resolvePreview(f.song, "ALT_2"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
  assert.equal(scans, 3);
});

test("preview resolver exposes watcher invalidation that discards its index and fingerprint caches", async t => {
  let scans = 0;
  const f = await fixture(t, {
    legacy: false,
    resolverOptions: { scanLibrary: async root => { scans += 1; return scanPerformanceLibrary(root); } },
  });
  assert.equal(typeof f.resolvePreview.invalidate, "function");
  await f.resolvePreview(f.song, "DEFAULT");
  f.resolvePreview.invalidate();
  await f.resolvePreview(f.song, "ALT_2");
  assert.equal(scans, 2);
});

test("DEFAULT source fingerprints reuse the actual preview hash stream without rereading the file", async t => {
  const reads = [];
  const createReadStream = fs.createReadStream;
  const reader = t.mock.method(fs, "createReadStream", (path, options) => {
    reads.push(path);
    return createReadStream(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { reader.mock.restore(); syncBuiltinESMExports(); });
  const f = await fixture(t);
  const source = join(f.library, f.variants.DEFAULT);

  assert.equal(await f.resolvePreview(f.song, "DEFAULT"), source);
  assert.deepEqual(await f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"), {
    path: source, sha256: hash(f.contents.DEFAULT),
  });
  assert.deepEqual(reads, [source], "verification and the source result share one real full-file read");
});

test("concurrent previews and source fingerprints share in-flight hashes", async t => {
  let reads = 0;
  const f = await fixture(t, { resolverOptions: { hashFile: async path => {
    reads += 1;
    return hash(await readFile(path));
  } } });
  const source = join(f.library, f.variants.DEFAULT);
  const results = await Promise.all([
    f.resolvePreview(f.song, "DEFAULT"),
    f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"),
  ]);
  assert.deepEqual(results, [source, { path: source, sha256: hash(f.contents.DEFAULT) }]);
  assert.equal(reads, 1);
});

test("source fingerprints bypass a present transformed cache and preserve content identity checks", async t => {
  const f = await fixture(t);
  const cached = f.song.videoByTodView.DEFAULT;
  await mkdir(join(f.root, ".faststart-cache", f.song.contentHash), { recursive: true });
  await writeFile(cached, "transformed cache bytes");
  assert.deepEqual(await f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"), {
    path: join(f.library, f.variants.DEFAULT), sha256: hash(f.contents.DEFAULT),
  });

  await writeFile(join(f.library, f.variants.DEFAULT), "replacement with a different identity");
  await assert.rejects(f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
  await assert.rejects(f.resolvePreview.sourceFingerprint(f.song, "MISSING"), { code: "MEDIA_PREVIEW_UNAVAILABLE" });
});

test("source fingerprint cancellation releases one waiter without aborting a live preview hash", async t => {
  let started;
  const hashing = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let hashSignal;
  let reads = 0;
  const f = await fixture(t, { resolverOptions: { hashFile: async (path, { signal } = {}) => {
    reads += 1;
    hashSignal = signal;
    started();
    await gate;
    return hash(await readFile(path));
  } } });
  const controller = new AbortController();
  const background = f.resolvePreview.sourceFingerprint(f.song, "DEFAULT", { signal: controller.signal });
  await hashing;
  const preview = f.resolvePreview(f.song, "DEFAULT");
  const rejected = assert.rejects(background, { name: "AbortError", code: "ABORT_ERR" });
  controller.abort();
  await rejected;
  assert.equal(hashSignal.aborted, false, "only resolver close owns shared hash cancellation");
  release();
  assert.equal(await preview, join(f.library, f.variants.DEFAULT));
  assert.equal((await f.resolvePreview.sourceFingerprint(f.song, "DEFAULT")).sha256, hash(f.contents.DEFAULT));
  assert.equal(reads, 1);
});

test("resolver close drains an actual aborted hash stream before resolving and rejects future direct previews", async t => {
  const f = await fixture(t);
  let stream;
  let closeWait;
  let drained = false;
  let releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  let startedClose;
  const closeStarted = new Promise(resolve => { startedClose = resolve; });
  let finishedClose;
  const closeFinished = new Promise(resolve => { finishedClose = resolve; });
  const createReadStream = fs.createReadStream;
  const reader = t.mock.method(fs, "createReadStream", (path, options) => {
    stream = createReadStream(path, { ...options, highWaterMark: 1, fs: {
      open: fs.open,
      read: fs.read,
      close: (fd, callback) => {
        startedClose();
        closeGate.then(() => fs.close(fd, callback));
      },
    } });
    stream.once("close", finishedClose);
    stream.once("data", () => {
      f.resolvePreview.invalidate();
      closeWait = f.resolvePreview.close();
      Promise.resolve(closeWait).then(() => { drained = true; });
    });
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => { reader.mock.restore(); syncBuiltinESMExports(); });

  try {
    await assert.rejects(f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"), { name: "AbortError", code: "ABORT_ERR" });
    await closeStarted;
    await Promise.resolve();
    assert.equal(drained, false, "close must wait for owned I/O even after its cache entry was invalidated");
  } finally { releaseClose(); await closeFinished; }
  await closeWait;
  assert.equal(drained, true);
  assert.equal(stream.destroyed, true);
  assert.equal(stream.closed, true);
  assert.ok(stream.bytesRead < Buffer.byteLength(f.contents.DEFAULT), "shutdown aborts instead of reading the whole source");
  f.song.videoByTodView.DEFAULT = join(f.library, f.variants.DEFAULT);
  f.resolvePreview.invalidate();
  await assert.rejects(f.resolvePreview(f.song, "DEFAULT"), { name: "AbortError", code: "ABORT_ERR" });
  await assert.rejects(f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"), { name: "AbortError", code: "ABORT_ERR" });
});

test("close rejects pending scans promptly and their later completion cannot publish a source", async t => {
  let started;
  const scanning = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let scanned;
  const scanFinished = new Promise(resolve => { scanned = resolve; });
  let reads = 0;
  const f = await fixture(t, { resolverOptions: {
    scanLibrary: async root => {
      started();
      await gate;
      const result = await scanPerformanceLibrary(root);
      scanned();
      return result;
    },
    hashFile: async path => { reads += 1; return hash(await readFile(path)); },
  } });
  const pending = f.resolvePreview.sourceFingerprint(f.song, "DEFAULT");
  await scanning;
  const rejected = assert.rejects(pending, { name: "AbortError", code: "ABORT_ERR" });
  f.resolvePreview.close();
  await rejected;
  release();
  await scanFinished;
  await assert.rejects(f.resolvePreview.sourceFingerprint(f.song, "DEFAULT"), { name: "AbortError", code: "ABORT_ERR" });
  assert.equal(reads, 0);
});
