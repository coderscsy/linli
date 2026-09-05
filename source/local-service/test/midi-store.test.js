import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MidiStore } from "../midi/store.js";
import { createOliviaService } from "../server.js";

test("song metadata overrides preserve identity, validate atomically and survive rescans", async () => {
  await withStore(async ({ store, db, root, advance }) => {
    const input = { id: "stable", name: "Original", sourceKind: "import", videoPath: "a.mp4", contentHash: "c".repeat(64), performanceType: "PlaySing", videoByTodView: { DEFAULT: "a.mp4", ALT_2: "b.mp4" } };
    const original = store.upsertUserSong(input);
    const revision = store.libraryRevision();
    advance(1);
    const edited = store.updateUserSongMetadata("stable", { name: "  自定名  ", timeOfDayMapping: { TOD20: "ALT_2" } });
    assert.equal(edited.name, "自定名");
    assert.equal(edited.originalName, "Original");
    for (const key of ["id", "contentHash", "videoPath", "midiPath", "performanceType", "createdAt"]) assert.deepEqual(edited[key], original[key]);
    assert.equal(store.libraryRevision(), revision + 1);
    for (const name of ["", "  ", "bad\u0000name", "x".repeat(201), 12]) {
      assert.throws(() => store.updateUserSongMetadata("stable", { name }), { code: "MIDI_SONG_NAME_INVALID" });
    }
    assert.throws(() => store.updateUserSongMetadata("stable", { name: "Wrong", timeOfDayMapping: { TOD20: "missing" } }), { code: "MIDI_SONG_MAPPING_INVALID" });
    assert.equal(store.libraryRevision(), revision + 1);
    assert.equal(store.getUserSong("stable").name, "自定名");
    store.upsertUserSong({ ...input, contentHash: null, name: "New source" });
    assert.equal(store.getUserSong("stable").name, "自定名");
    assert.equal(store.getUserSong("stable").timeOfDayMapping.TOD20, "ALT_2");
    assert.equal(new MidiStore({ db, root }).getUserSong("stable").customName, "自定名");
    assert.equal(store.pagePublishedUserSongs({ query: "自定" }).total, 1);
    assert.equal(store.listUserSongs("自定").length, 1);
    store.upsertUserSong({ ...input, id: "separate", contentHash: null, name: "自定名" });
    assert.equal(store.listUserSongs("自定名").length, 2);
    assert.equal(store.updateUserSongMetadata("stable", { name: null }).name, "Original");
  });
});

test("permanent corrections survive reopen, upsert and delete-reimport by fingerprint without changing source identity", async () => {
  await withStore(async ({ store, db, root }) => {
    const input = { id: "corrected", name: "Source", sourceKind: "import", contentHash: "e".repeat(64), videoPath: "a.mp4", videoByTodView: { DEFAULT: "a.mp4" } };
    const original = store.upsertUserSong(input);
    store.updateUserSongMetadata(input.id, { name: "Display", timeOfDayMapping: { TOD20: "DEFAULT" } });
    const saved = store.updateUserSongMetadata(input.id, { permanentName: "真正曲名" });
    assert.equal(saved.name, "真正曲名");
    assert.equal(saved.correctedName, "真正曲名");
    assert.equal(saved.customName, null);
    for (const key of ["id", "originalName", "contentHash", "videoPath", "midiPath"]) assert.equal(saved[key], original[key]);
    assert.equal(saved.timeOfDayMapping.TOD20, "DEFAULT");
    assert.equal(new MidiStore({ db, root }).getUserSong(input.id).name, "真正曲名");
    const reopenedDb = new DatabaseSync(join(root, "test.sqlite"));
    try { assert.equal(new MidiStore({ db: reopenedDb, root }).getUserSong(input.id).correctedName, "真正曲名"); }
    finally { reopenedDb.close(); }
    store.updateUserSongMetadata(input.id, { name: "Temporary" });
    assert.equal(store.updateUserSongMetadata(input.id, { name: null }).name, "真正曲名");
    assert.equal(store.upsertUserSong({ ...input, name: "Wrong" }).name, "真正曲名");
    assert.equal(store.pagePublishedUserSongs({ query: "真正" }).total, 1);
    assert.equal(store.listUserSongs("真正").length, 1);
    for (const permanentName of [null, "", "bad\u0000name", "x".repeat(201), 12]) assert.throws(() => store.updateUserSongMetadata(input.id, { permanentName }), { code: "MIDI_SONG_NAME_INVALID" });
    store.deleteUserSong(input.id);
    const reimport = store.upsertUserSong({ ...input, id: "reimported" });
    assert.equal(reimport.name, "真正曲名");
    assert.equal(reimport.originalName, "Source");
    assert.equal(store.upsertUserSong({ ...input, id: "unrelated", contentHash: "f".repeat(64) }).name, "Source");
  });
});

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "olivia-midi-store-"));
  const db = new DatabaseSync(join(root, "test.sqlite"));
  let now = 1_700_000_000;
  const ids = ["token-1", "job-1", "song-1", "token-2", "job-2", "song-2"];
  const store = new MidiStore({
    db,
    root,
    now: () => now,
    randomId: () => ids.shift(),
  });
  try {
    await run({ db, root, store, advance: seconds => { now += seconds; } });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("MIDI store creates its schema and persists one-time upload tokens", async () => {
  await withStore(async ({ db, root, store, advance }) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    assert.ok(tables.includes("midi_upload_tokens"));
    assert.ok(tables.includes("midi_jobs"));
    assert.ok(tables.includes("user_songs"));

    const created = store.createUploadToken({ originalFilename: "../奇怪 名称.MIDI", lifetimeSeconds: 60 });
    assert.equal(created.token, "token-1");
    assert.match(created.key, /^uploads\/token-1\/[-\w]+\.midi$/u);

    const inputPath = join(root, "inputs", "token-1.midi");
    const consumed = store.consumeUploadToken(created.token, {
      inputPath,
      sha256: "a".repeat(64),
      sizeBytes: 123,
    });
    assert.equal(consumed.inputPath, "inputs/token-1.midi");
    assert.equal(store.getUploadByKey(created.key).sha256, "a".repeat(64));
    assert.throws(() => store.consumeUploadToken(created.token, {
      inputPath,
      sha256: "a".repeat(64),
      sizeBytes: 123,
    }), { code: "UPLOAD_TOKEN_USED" });

    const expired = store.createUploadToken({ originalFilename: "late.mid", lifetimeSeconds: 1 });
    advance(2);
    assert.throws(() => store.consumeUploadToken(expired.token, {
      inputPath: join(root, "inputs", "late.mid"),
      sha256: "b".repeat(64),
      sizeBytes: 1,
    }), { code: "UPLOAD_TOKEN_EXPIRED" });
  });
});

test("MIDI store rejects unvalidated paths outside its managed root", async () => {
  await withStore(async ({ root, store }) => {
    const token = store.createUploadToken({ originalFilename: "safe.mid" });
    assert.throws(() => store.consumeUploadToken(token.token, {
      inputPath: join(root, "..", "escaped.mid"),
      sha256: "c".repeat(64),
      sizeBytes: 1,
    }), { code: "MIDI_PATH_OUTSIDE_ROOT" });

    const libraryRoot = join(root, "library");
    const stored = store.encodePath(join(libraryRoot, "song.mp4"), { externalRoot: libraryRoot });
    assert.match(stored, /^external:/u);
    assert.throws(() => store.encodePath(join(root, "other", "song.mp4"), { externalRoot: libraryRoot }), {
      code: "MIDI_PATH_OUTSIDE_LIBRARY",
    });
  });
});

test("MIDI store enforces job state transitions, cancellation, and restart recovery", async () => {
  await withStore(async ({ root, store }) => {
    const token = store.createUploadToken({ originalFilename: "song.mid" });
    store.consumeUploadToken(token.token, {
      inputPath: join(root, "inputs", "song.mid"),
      sha256: "d".repeat(64),
      sizeBytes: 42,
    });
    const job = store.createJob({ uploadKey: token.key, title: "Song" });
    assert.equal(job.state, "queued");
    assert.throws(() => store.transitionJob(job.id, "rendering"), { code: "MIDI_JOB_TRANSITION_INVALID" });

    store.transitionJob(job.id, "analyzing", { progress: 5 });
    store.transitionJob(job.id, "synthesizing", { progress: 25, timelinePath: join(root, "jobs", job.id, "timeline.json") });
    store.requestCancellation(job.id);
    assert.equal(store.getJob(job.id).cancelRequested, true);
    store.transitionJob(job.id, "cancelled", { progress: 25 });
    assert.equal(store.getJob(job.id).state, "cancelled");

    const secondToken = store.createUploadToken({ originalFilename: "resume.mid" });
    store.consumeUploadToken(secondToken.token, {
      inputPath: join(root, "inputs", "resume.mid"),
      sha256: "e".repeat(64),
      sizeBytes: 43,
    });
    const secondJob = store.createJob({ uploadKey: secondToken.key, title: "Resume" });
    store.transitionJob(secondJob.id, "analyzing");
    assert.equal(store.requeueInterruptedJobs(), 1);
    assert.equal(store.getJob(secondJob.id).state, "queued");
  });
});

test("MIDI store persists and deduplicates user songs", async () => {
  await withStore(async ({ db, root, store }) => {
    const song = store.upsertUserSong({
      name: "水边的阿狄丽娜",
      sourceKind: "upload",
      midiPath: join(root, "inputs", "ballade.mid"),
      videoPath: join(root, "outputs", "ballade.mp4"),
      durationUs: 12_500_000,
      contentHash: "f".repeat(64),
      videoByTodView: { TOD1730_NI_L: "outputs/ballade.mp4" },
      performanceType: "PlaySing",
    });
    const duplicate = store.upsertUserSong({
      name: "另一个名字",
      sourceKind: "import",
      videoPath: join(root, "outputs", "duplicate.mp4"),
      durationUs: 10,
      contentHash: "f".repeat(64),
    });

    assert.equal(duplicate.id, song.id);
    assert.equal(store.listUserSongs().length, 1);
    assert.deepEqual(store.getUserSong(song.id).videoByTodView, { TOD1730_NI_L: "outputs/ballade.mp4" });
    assert.equal(store.getUserSong(song.id).performanceType, "PlaySing");

    const missing = store.upsertUserSong({
      name: "待修复时长",
      sourceKind: "import",
      videoPath: join(root, "outputs", "missing-duration.mp4"),
      durationUs: 0,
      contentHash: "a".repeat(64),
    });
    assert.equal(missing.performanceType, "Solo");
    store.upsertUserSong({
      name: "没有视频",
      sourceKind: "upload",
      durationUs: 0,
      contentHash: "b".repeat(64),
    });
    assert.deepEqual(store.listUserSongsMissingDuration().map(item => item.id), [missing.id]);
    assert.equal(store.updateUserSongDuration(missing.id, 8_750_000).durationUs, 8_750_000);
    assert.equal(store.listUserSongsMissingDuration().length, 0);

    const reopened = new MidiStore({ db, root });
    assert.equal(reopened.getUserSong(song.id).name, "水边的阿狄丽娜");
    assert.equal(reopened.deleteUserSong(song.id), true);
    assert.equal(reopened.deleteUserSong(song.id), false);
  });
});

test("Olivia service keeps the legacy media index without starting a MIDI renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-midi-service-"));
  const dataDir = join(root, "data");
  const service = await createOliviaService({
    root,
    dataDir,
    worker: false,
    runMemoryRefresh: false,
  });
  try {
    assert.ok(service.midiStore instanceof MidiStore);
    assert.equal(service.midiPipeline, null);
    assert.equal(service.midiQueue.active, null);
    assert.equal(service.midiStore.root, join(dataDir, "media"));
    assert.equal(service.midiStore.listJobs().length, 0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
