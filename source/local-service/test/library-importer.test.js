import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { importPerformanceLibrary, scanPerformanceLibrary } from "../midi/library-importer.js";
import { MidiStore } from "../midi/store.js";
import { endOfTrack, midiFile, track } from "./fixtures/midi-fixtures.js";

async function libraryFixture() {
  const testRoot = "I:\\CodexData\\test-temp";
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "olivia-library-import-"));
  const libraryRoot = join(root, "library");
  const managedRoot = join(root, "managed");
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(managedRoot, { recursive: true });
  const db = new DatabaseSync(join(root, "test.sqlite"));
  const store = new MidiStore({ db, root: managedRoot });
  return {
    root,
    libraryRoot,
    managedRoot,
    db,
    store,
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("library scanner groups top-level songs and selects TOD1730_NI_L", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "水边的阿狄丽娜");
    await mkdir(join(song, "videos"), { recursive: true });
    await writeFile(join(song, "score.mid"), midiFile({ tracks: [track(endOfTrack())] }));
    await writeFile(join(song, "videos", "take_TOD1200_WI_R.mp4"), "video-1");
    await writeFile(join(song, "videos", "take_TOD1730_NI_L.mp4"), "video-2");

    const preview = await scanPerformanceLibrary(ctx.libraryRoot);

    assert.equal(preview.entries.length, 1);
    assert.equal(preview.entries[0].name, "水边的阿狄丽娜");
    assert.equal(preview.entries[0].videoPath, join(song, "videos", "take_TOD1730_NI_L.mp4"));
    assert.deepEqual(Object.keys(preview.entries[0].videoByTodView).sort(), ["TOD1200_WI_R", "TOD1730_NI_L"]);
    assert.equal(preview.entries[0].midiPath, join(song, "score.mid"));
  } finally {
    await ctx.close();
  }
});

test("library scanner expands nested midi performance folders instead of importing category folders", async () => {
  const ctx = await libraryFixture();
  try {
    const category = join(ctx.libraryRoot, "原神3", "米哈游 原神3");
    const first = join(category, "midi_100_1784000001");
    const second = join(category, "midi_200_1784000002");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, "view-a.mp4"), "first-a");
    await writeFile(join(first, "view-b.mp4"), "first-b");
    await writeFile(join(second, "view-a.mp4"), "second-a");

    const preview = await scanPerformanceLibrary(ctx.libraryRoot);

    assert.equal(preview.source, "performance-folders");
    assert.equal(preview.entries.length, 2);
    assert.deepEqual(preview.entries.map(entry => entry.name), [
      "原神3 · midi_100_1784000001",
      "原神3 · midi_200_1784000002",
    ]);
    assert.deepEqual(preview.entries.map(entry => Object.keys(entry.videoByTodView).length), [2, 1]);
  } finally {
    await ctx.close();
  }
});

test("library scanner merges manifest songs with newly downloaded midi performance folders", async () => {
  const ctx = await libraryFixture();
  try {
    const group = join(ctx.libraryRoot, "其他", "米哈游 其他");
    const listed = join(group, "midi_100_1");
    const downloaded = join(group, "midi_200_2");
    await mkdir(listed, { recursive: true });
    await mkdir(downloaded, { recursive: true });
    await writeFile(join(listed, "listed.mp4"), "listed");
    await writeFile(join(downloaded, "downloaded.mp4"), "downloaded");
    await writeFile(join(ctx.libraryRoot, "library.json"), JSON.stringify({
      songs: [{ name: "清单曲目【其他 · SHARE1】", video: "其他/米哈游 其他/midi_100_1/listed.mp4" }],
    }));

    const preview = await scanPerformanceLibrary(ctx.libraryRoot);

    assert.equal(preview.source, "manifest-json+performance-folders");
    assert.deepEqual(preview.entries.map(entry => entry.name), [
      "清单曲目【其他 · SHARE1】",
      "其他 · midi_200_2",
    ]);
  } finally {
    await ctx.close();
  }
});

test("library scanner supports JSON and CSV manifests and rejects escaped paths", async () => {
  const ctx = await libraryFixture();
  try {
    await writeFile(join(ctx.libraryRoot, "one.mp4"), "one");
    await writeFile(join(ctx.libraryRoot, "two.mid"), midiFile({ tracks: [track(endOfTrack())] }));
    await writeFile(join(ctx.libraryRoot, "library.json"), JSON.stringify({
      songs: [{ name: "Manifest One", video: "one.mp4", tod: "TOD2000", view: "WI_L", performanceType: "PlaySing" }],
    }));
    let preview = await scanPerformanceLibrary(ctx.libraryRoot);
    assert.equal(preview.source, "manifest-json");
    assert.equal(preview.entries[0].videoByTodView.TOD2000_WI_L, join(ctx.libraryRoot, "one.mp4"));
    assert.equal(preview.entries[0].performanceType, "PlaySing");

    await rm(join(ctx.libraryRoot, "library.json"));
    await writeFile(join(ctx.libraryRoot, "library.csv"), "name,midi\nManifest Two,two.mid\n");
    preview = await scanPerformanceLibrary(ctx.libraryRoot);
    assert.equal(preview.source, "manifest-csv");
    assert.equal(preview.entries[0].midiPath, join(ctx.libraryRoot, "two.mid"));

    await writeFile(join(ctx.libraryRoot, "library.csv"), "name,video\nEscape,../outside.mp4\n");
    await assert.rejects(scanPerformanceLibrary(ctx.libraryRoot), { code: "LIBRARY_PATH_OUTSIDE_ROOT" });
  } finally {
    await ctx.close();
  }
});

test("library importer references completed videos and skips MIDI-only entries", async () => {
  const ctx = await libraryFixture();
  try {
    const videoSong = join(ctx.libraryRoot, "Video Song");
    const midiSong = join(ctx.libraryRoot, "MIDI Song");
    await mkdir(videoSong);
    await mkdir(midiSong);
    await writeFile(join(videoSong, "take_TOD1730_NI_L.mp4"), "video-content");
    await writeFile(join(midiSong, "score.midi"), midiFile({ tracks: [track(endOfTrack())] }));
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const enqueued = [];

    const probed = [];
    const imported = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue: id => enqueued.push(id) },
      mode: "copy",
      managedRoot: join(ctx.root, "official-media"),
      probeVideoDurationUs: async path => {
        probed.push(path);
        return 123_456_000;
      },
    });

    assert.equal(imported.imported, 1);
    assert.equal(imported.skipped, 1);
    assert.equal(ctx.store.listUserSongs().length, 1);
    assert.match(ctx.store.listUserSongs()[0].videoPath, /^external:/u);
    assert.equal(ctx.store.listUserSongs()[0].durationUs, 123_456_000);
    assert.deepEqual(probed, [join(videoSong, "take_TOD1730_NI_L.mp4")]);
    assert.equal(ctx.store.listJobs().length, 0);
    assert.deepEqual(enqueued, []);
    assert.deepEqual(
      imported.details.find(item => item.name === "MIDI Song"),
      { name: "MIDI Song", state: "skipped", reason: "missing-official-video", message: "缺少官方生成的视频" },
    );

    const repeated = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue: id => enqueued.push(id) },
      mode: "copy",
      managedRoot: join(ctx.root, "official-media"),
      probeVideoDurationUs: async () => 123_456_000,
    });
    assert.equal(repeated.imported, 0);
    assert.equal(repeated.skipped, 2);
  } finally {
    await ctx.close();
  }
});

test("library importer safely copies verified videos below the configured official-media root", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Copied Song");
    await mkdir(song);
    await writeFile(join(song, "take.mp4"), "copy-me");
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);

    const result = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "copy",
      managedRoot: join(ctx.root, "song-storage", "OliviaSoul", "我的上传"),
      probeVideoDurationUs: async () => 8_000_000,
    });

    assert.equal(result.imported, 1);
    assert.match(ctx.store.listUserSongs()[0].videoPath, /^external:/u);
    assert.equal(ctx.store.listUserSongs()[0].durationUs, 8_000_000);
    assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(song, "take.mp4"), "utf8")), "copy-me");
  } finally {
    await ctx.close();
  }
});

test("library importer skips damaged MP4 and never creates an empty work", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Broken Song");
    await mkdir(song);
    await writeFile(join(song, "broken.mp4"), "not-an-mp4");
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const result = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "copy",
      managedRoot: join(ctx.root, "official-media"),
      probeVideoDurationUs: async () => { throw new Error("视频没有有效流"); },
    });

    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);
    assert.equal(ctx.store.listUserSongs().length, 0);
    assert.deepEqual(result.details[0], {
      name: "Broken Song",
      state: "skipped",
      reason: "invalid-video",
      message: "视频没有有效流",
    });
  } finally {
    await ctx.close();
  }
});

test("library importer refuses the whole batch before copying when target space is insufficient", async () => {
  const ctx = await libraryFixture();
  try {
    for (const name of ["First", "Second"]) {
      const song = join(ctx.libraryRoot, name);
      await mkdir(song);
      await writeFile(join(song, "take.mp4"), `video-${name}`);
    }
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    await assert.rejects(importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "copy",
      managedRoot: join(ctx.root, "official-media"),
      probeVideoDurationUs: async () => 1_000_000,
      getFreeBytes: async () => 512 * 1024 ** 2,
    }), error => error.code === "LIBRARY_INSUFFICIENT_SPACE" && error.requiredBytes > 0);
    assert.equal(ctx.store.listUserSongs().length, 0);
  } finally {
    await ctx.close();
  }
});

test("reference reimport skips a source matched by its original name before hashing or space probing", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Source title");
    await mkdir(song);
    await writeFile(join(song, "take.mp4"), "verified source");
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const first = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      probeVideoDurationUs: async () => 1_000_000,
    });
    assert.equal(first.imported, 1);
    const registered = ctx.store.listUserSongs()[0];
    ctx.store.updateUserSongMetadata(registered.id, { name: "Corrected display title" });

    let hashCalls = 0;
    let spaceCalls = 0;
    let probeCalls = 0;
    const repeated = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      hashFile: async () => { hashCalls += 1; throw new Error("unchanged source must not hash"); },
      getFreeBytes: async () => { spaceCalls += 1; return 0; },
      probeVideoDurationUs: async () => { probeCalls += 1; return 1_000_000; },
    });

    assert.equal(repeated.imported, 0);
    assert.equal(repeated.details[0].reason, "duplicate");
    assert.equal(hashCalls, 0);
    assert.equal(spaceCalls, 0);
    assert.equal(probeCalls, 0);
  } finally {
    await ctx.close();
  }
});

test("renamed registered source revalidates a replaced original clip instead of blindly skipping its original name", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Original source title");
    const clip = join(song, "take.mp4");
    await mkdir(song);
    await writeFile(clip, "first verified source");
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      probeVideoDurationUs: async () => 1_000_000,
    });
    ctx.store.updateUserSongMetadata(ctx.store.listUserSongs()[0].id, { name: "Corrected display title" });
    await writeFile(clip, "replacement source with a different content identity");

    let hashCalls = 0;
    let probeCalls = 0;
    const result = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      hashFile: async path => {
        hashCalls += 1;
        return createHash("sha256").update(await readFile(path)).digest("hex");
      },
      probeVideoDurationUs: async () => { probeCalls += 1; return 1_000_000; },
    });

    assert.equal(result.imported, 1);
    assert.equal(result.details[0].state, "registered");
    assert.ok(hashCalls > 0, "changed source must be content-verified");
    assert.ok(probeCalls > 0, "changed source must be media-validated");
  } finally {
    await ctx.close();
  }
});

test("cold existing-hash validation seeds the unchanged-reference cache for the next renamed reimport", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Seeded source title");
    const clip = join(song, "take.mp4");
    const body = "preexisting verified source";
    await mkdir(song);
    await writeFile(clip, body);
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const fileHash = createHash("sha256").update(body).digest("hex");
    const contentHash = createHash("sha256").update(`DEFAULT\u0000${fileHash}\u0000`).digest("hex");
    const stored = ctx.store.upsertUserSong({
      name: "Seeded source title",
      sourceKind: "official-import",
      videoPath: clip,
      videoByTodView: { DEFAULT: clip },
      contentHash,
      externalRoot: ctx.libraryRoot,
    });
    ctx.store.updateUserSongMetadata(stored.id, { name: "Corrected display title" });

    let coldHashes = 0;
    let coldProbes = 0;
    const cold = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      hashFile: async path => {
        coldHashes += 1;
        return createHash("sha256").update(await readFile(path)).digest("hex");
      },
      probeVideoDurationUs: async () => { coldProbes += 1; return 1_000_000; },
    });
    assert.equal(cold.imported, 0);
    assert.ok(coldHashes > 0);
    assert.ok(coldProbes > 0);

    let warmHashes = 0;
    let warmProbes = 0;
    const warm = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      hashFile: async () => { warmHashes += 1; throw new Error("warm source must not hash"); },
      probeVideoDurationUs: async () => { warmProbes += 1; return 1_000_000; },
    });
    assert.equal(warm.imported, 0);
    assert.equal(warmHashes, 0);
    assert.equal(warmProbes, 0);
  } finally {
    await ctx.close();
  }
});

test("cold legacy import identity keeps its corrected song instead of creating a duplicate row", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Legacy source title");
    const clip = join(song, "take.mp4");
    const body = "legacy default source";
    await mkdir(song);
    await writeFile(clip, body);
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const legacyHash = createHash("sha256").update(body).digest("hex");
    const cacheClip = join(ctx.managedRoot, ".faststart-cache", legacyHash, "DEFAULT.mp4");
    const stored = ctx.store.upsertUserSong({
      name: "Legacy source title",
      sourceKind: "import",
      videoPath: cacheClip,
      videoByTodView: { DEFAULT: cacheClip },
      contentHash: legacyHash,
    });
    ctx.store.updateUserSongMetadata(stored.id, { name: "Corrected legacy title", timeOfDayMapping: { TOD12: "DEFAULT" } });

    const result = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      probeVideoDurationUs: async () => 1_000_000,
    });
    assert.equal(result.imported, 0);
    assert.equal(ctx.store.listUserSongs().length, 1);
    const preserved = ctx.store.listUserSongs()[0];
    assert.equal(preserved.id, stored.id);
    assert.equal(preserved.name, "Corrected legacy title");
    assert.deepEqual(preserved.timeOfDayMapping, { TOD12: "DEFAULT", TOD1730: null, TOD20: null });
  } finally {
    await ctx.close();
  }
});

test("legacy default-hash identity does not bind variants spread across different source work folders", async () => {
  const ctx = await libraryFixture();
  try {
    const day = join(ctx.libraryRoot, "day");
    const night = join(ctx.libraryRoot, "night");
    await mkdir(day);
    await mkdir(night);
    await writeFile(join(day, "take.mp4"), "legacy default clip");
    await writeFile(join(night, "take.mp4"), "unrelated alternate clip");
    await writeFile(join(ctx.libraryRoot, "library.json"), JSON.stringify({
      songs: [{ name: "Split legacy source", variants: { DEFAULT: "day/take.mp4", ALT: "night/take.mp4" } }],
    }));
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const legacyHash = createHash("sha256").update("legacy default clip").digest("hex");
    const cacheRoot = join(ctx.managedRoot, ".faststart-cache", legacyHash);
    ctx.store.upsertUserSong({
      name: "Split legacy source",
      sourceKind: "import",
      videoPath: join(cacheRoot, "DEFAULT.mp4"),
      videoByTodView: { DEFAULT: join(cacheRoot, "DEFAULT.mp4"), ALT: join(cacheRoot, "ALT.mp4") },
      contentHash: legacyHash,
    });

    const result = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      probeVideoDurationUs: async () => 1_000_000,
    });
    assert.equal(result.imported, 1, "different source work folders must not inherit DEFAULT-only legacy identity");
  } finally {
    await ctx.close();
  }
});

test("a source changed while hashing never seeds the unchanged-reference cache with stale identity", async () => {
  const ctx = await libraryFixture();
  try {
    const song = join(ctx.libraryRoot, "Racing source title");
    const clip = join(song, "take.mp4");
    await mkdir(song);
    await writeFile(clip, "old content before hash");
    const preview = await scanPerformanceLibrary(ctx.libraryRoot);
    const oldFileHash = createHash("sha256").update("old content before hash").digest("hex");
    const oldContentHash = createHash("sha256").update(`DEFAULT\u0000${oldFileHash}\u0000`).digest("hex");
    const stored = ctx.store.upsertUserSong({
      name: "Racing source title",
      sourceKind: "official-import",
      videoPath: clip,
      videoByTodView: { DEFAULT: clip },
      contentHash: oldContentHash,
      externalRoot: ctx.libraryRoot,
    });
    ctx.store.updateUserSongMetadata(stored.id, { name: "Corrected racing title" });

    let mutated = false;
    const unstable = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      hashFile: async path => {
        const bytes = await readFile(path);
        if (!mutated) {
          mutated = true;
          await writeFile(path, "new content after hash");
        }
        return createHash("sha256").update(bytes).digest("hex");
      },
      probeVideoDurationUs: async () => 1_000_000,
    });
    assert.deepEqual(unstable.details[0], { name: "Racing source title", state: "skipped", reason: "source-changed" });

    let retryHashes = 0;
    const retry = await importPerformanceLibrary(preview, {
      store: ctx.store,
      queue: { enqueue() {} },
      mode: "reference",
      hashFile: async path => {
        retryHashes += 1;
        return createHash("sha256").update(await readFile(path)).digest("hex");
      },
      probeVideoDurationUs: async () => 1_000_000,
    });
    assert.equal(retry.imported, 1);
    assert.ok(retryHashes > 0, "the retry must re-hash rather than accept a stale warm signature");
  } finally {
    await ctx.close();
  }
});
