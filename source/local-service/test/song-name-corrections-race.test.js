import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MidiStore } from "../midi/store.js";
import { createSongNameCorrections } from "../midi/song-name-corrections.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Keep the store and manager real, but hold the portable-document read in
// memory so this race is deterministic and never touches media or disk files.
async function duringBackgroundDocumentRead(run) {
  const db = new DatabaseSync(":memory:");
  const root = join(tmpdir(), "olivia-name-corrections-no-io");
  const store = new MidiStore({ db, root });
  const contentHash = "b".repeat(64);
  const videoPath = `.faststart-cache/${contentHash}/DEFAULT.mp4`;
  const input = { id: "work", name: "Source", sourceKind: "import", contentHash,
    videoPath, videoByTodView: { DEFAULT: videoPath } };
  store.upsertUserSong(input);
  const entered = deferred(), release = deferred();
  let holdNextRead = false;
  let document = JSON.stringify({ version: 1, records: [] });
  let draft;
  const originals = Object.fromEntries(["readFile", "mkdir", "open", "rename", "rm"]
    .map(key => [key, fs[key]]));
  fs.readFile = async () => {
    const savedDocument = document;
    if (holdNextRead) {
      holdNextRead = false;
      entered.resolve();
      await release.promise;
    }
    return savedDocument;
  };
  fs.mkdir = fs.rm = async () => {};
  fs.open = async () => ({ writeFile: async value => { draft = value; }, sync: async () => {}, close: async () => {} });
  fs.rename = async () => { document = draft; };
  syncBuiltinESMExports();
  const resolver = async () => { throw new Error("sourceFingerprint must be used"); };
  resolver.sourceFingerprint = async () => ({ sha256: "d".repeat(64) });
  let manager;
  try {
    manager = await createSongNameCorrections({ root, store, resolveSongPreview: resolver });
    await manager.save(input.id, { permanentName: "Durable old title" });
    holdNextRead = true;
    await entered.promise;
    await run({ store, input });
    release.resolve();
    await manager.whenIdle();
    assert.deepEqual(store.listSongNameCorrections().map(row => row.fingerprint), [contentHash],
      "a worker must not attach its old source alias after the work changes during JSON I/O");
    assert.deepEqual(JSON.parse(document).records.map(row => row.fingerprint), [contentHash]);
    return store.getUserSong(input.id);
  } finally {
    release.resolve();
    try { await manager?.close(); }
    finally { Object.assign(fs, originals); syncBuiltinESMExports(); db.close(); }
  }
}

// Node's default test-file process isolation prevents these temporary builtin
// mocks from reaching other files; keep the two tests in this file sequential.
test("deletion during background JSON read cannot register the deleted work's alias", { concurrency: false, timeout: 5000 }, async () => {
  const song = await duringBackgroundDocumentRead(async ({ store, input }) => {
    store.deleteUserSong(input.id);
  });
  assert.equal(song, null);
});

test("same-ID identity replacement during background JSON read cannot register the old alias", { concurrency: false, timeout: 5000 }, async () => {
  const song = await duringBackgroundDocumentRead(async ({ store, input }) => {
    store.deleteUserSong(input.id);
    store.upsertUserSong({ ...input, name: "Replacement source", contentHash: "c".repeat(64),
      videoPath: "replacement.mp4", videoByTodView: { DEFAULT: "replacement.mp4" } });
  });
  assert.equal(song.contentHash, "c".repeat(64));
  assert.equal(song.name, "Replacement source");
  assert.equal(song.videoPath, "replacement.mp4");
});
