import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MidiStore } from "../midi/store.js";
import { createSongNameCorrections } from "../midi/song-name-corrections.js";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "olivia-name-corrections-"));
  const db = new DatabaseSync(join(root, "test.sqlite"));
  const store = new MidiStore({ db, root });
  const file = join(root, "settings", "song-name-corrections.json");
  const input = { id: "work", name: "Source", sourceKind: "import", contentHash: "b".repeat(64), videoPath: "source.mp4" };
  store.upsertUserSong(input);
  try { await run({ root, db, store, file, input }); }
  finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test("portable corrections restore after database loss and concurrent saves keep every fingerprint", async () => fixture(async ({ root, store, file, input }) => {
  const manager = await createSongNameCorrections({ root, store });
  store.upsertUserSong({ ...input, id: "two", contentHash: "c".repeat(64) });
  await Promise.all([manager.save("work", { permanentName: "First" }), manager.save("two", { permanentName: "Second" })]);
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.records.length, 2);
  assert.ok(document.records.every(row => Object.keys(row).sort().join() === "correctedName,fingerprint,identity,updatedAt"));
  const fresh = new DatabaseSync(":memory:");
  try {
    const restored = new MidiStore({ db: fresh, root });
    await createSongNameCorrections({ root, store: restored });
    assert.equal(restored.upsertUserSong(input).name, "First");
    assert.equal(restored.upsertUserSong({ ...input, id: "two", contentHash: "c".repeat(64) }).name, "Second");
  } finally { fresh.close(); }
}));

test("startup retries DB projection and rejects malformed records without discarding the file or database", async () => fixture(async ({ root, store, file }) => {
  const manager = await createSongNameCorrections({ root, store });
  await mkdir(file, { recursive: true });
  const saved = await manager.save("work", { permanentName: "DB winner" });
  assert.equal(saved.name, "DB winner");
  assert.equal(manager.status().state, "failed");
  await rm(file, { recursive: true });
  const restarted = await createSongNameCorrections({ root, store });
  assert.equal(restarted.status().state, "synced");
  const previous = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ version: 1, records: [...previous.records, { fingerprint: "invalid" }] }));
  const malformed = await readFile(file, "utf8");
  const rejected = await createSongNameCorrections({ root, store });
  assert.equal(rejected.status().state, "failed");
  await rejected.save("work", { permanentName: "DB still writable" });
  assert.equal(store.getUserSong("work").name, "DB still writable");
  assert.equal(await readFile(file, "utf8"), malformed);
  await writeFile(file, JSON.stringify(previous));
  const retry = await createSongNameCorrections({ root, store });
  assert.equal(retry.status().state, "synced");
  assert.equal(JSON.parse(await readFile(file, "utf8")).records[0].correctedName, "DB still writable");
}));

test("a missing work fingerprint reports incomplete portability while preserving the DB correction", async () => fixture(async ({ root, store }) => {
  store.upsertUserSong({ id: "no-fingerprint", name: "Source", sourceKind: "official-import" });
  const manager = await createSongNameCorrections({ root, store });
  const song = await manager.save("no-fingerprint", { permanentName: "DB title" });
  assert.equal(song.correctedName, "DB title");
  assert.equal(manager.status().state, "failed");
  assert.match(manager.status().error, /标识/u);
  assert.equal(manager.status("work").state, "synced", "unrelated uncorrected works do not inherit an identity-specific failure");
}));

test("identity resolution errors never expose filesystem paths in metadata", async () => fixture(async ({ root, store, input }) => {
  store.upsertUserSong({ ...input, id: "legacy", contentHash: "d".repeat(64), videoPath: `.faststart-cache/${"d".repeat(64)}/DEFAULT.mp4`, videoByTodView: { DEFAULT: `.faststart-cache/${"d".repeat(64)}/DEFAULT.mp4` } });
  const manager = await createSongNameCorrections({ root, store, resolveSongPreview: async () => { throw new Error("PRIVATE-PATH/source.mp4"); } });
  await manager.save("legacy", { permanentName: "Safe title" });
  await manager.whenIdle();
  assert.equal(manager.status("legacy").state, "failed");
  assert.equal(manager.status("legacy").error.includes("PRIVATE-PATH"), false);
  await manager.close();
}));

test("newer portable alias correction wins for every fingerprint of the same work", async () => fixture(async ({ root, store, file, input }) => {
  const manager = await createSongNameCorrections({ root, store });
  await manager.save("work", { permanentName: "Older title" });
  const previous = JSON.parse(await readFile(file, "utf8")).records[0];
  await writeFile(file, JSON.stringify({ version: 1, records: [{ ...previous, fingerprint: "c".repeat(64), correctedName: "Newer title", updatedAt: previous.updatedAt + 1000 }] }));
  await createSongNameCorrections({ root, store });
  assert.equal(store.getUserSong("work").name, "Newer title");
  store.deleteUserSong("work");
  assert.equal(store.upsertUserSong({ ...input, contentHash: "c".repeat(64) }).name, "Newer title");
}));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function legacyInput(input) {
  const base = `.faststart-cache/${input.contentHash}`;
  return { ...input, videoPath: `${base}/DEFAULT.mp4`, videoByTodView: { DEFAULT: `${base}/DEFAULT.mp4`, ALT_2: `${base}/ALT_2.mp4` } };
}
function installLegacy(store, input) {
  store.deleteUserSong(input.id);
  store.upsertUserSong(legacyInput(input));
}
function slowResolver(gate) {
  const calls = [];
  const resolve = async () => { await gate.promise; throw new Error("old synchronous path"); };
  resolve.sourceFingerprint = async (song, key, { signal } = {}) => {
    calls.push(key);
    await Promise.race([gate.promise, new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    })]);
    return { path: `source/${key}.mp4`, sha256: (key === "DEFAULT" ? "d" : "a").repeat(64) };
  };
  resolve.calls = calls;
  return resolve;
}

test("permanent rename flushes DB and JSON before slow legacy hashing; later edits do not queue behind media", async () => fixture(async ({ root, store, file, input }) => {
  installLegacy(store, input);
  const gate = deferred();
  const resolver = slowResolver(gate);
  const manager = await createSongNameCorrections({ root, store, resolveSongPreview: resolver });
  let deadline;
  try {
    const saved = await Promise.race([manager.save("work", { permanentName: "First correction" }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("save blocked on media hash")), 3000); })]);
    clearTimeout(deadline);
    assert.equal(saved.name, "First correction");
    assert.equal(JSON.parse(await readFile(file, "utf8")).records[0].correctedName, "First correction");
    assert.equal(manager.status("work").state, "pending");
    await manager.save("work", { permanentName: "Latest correction" });
    await manager.save("work", { name: "Display alias" });
    assert.equal(store.getUserSong("work").name, "Display alias");
    gate.resolve();
    await manager.whenIdle();
    assert.equal(manager.status("work").state, "synced");
    assert.deepEqual(resolver.calls.sort(), ["ALT_2", "DEFAULT"]);
    const records = JSON.parse(await readFile(file, "utf8")).records;
    assert.equal(records.length, 2);
    assert.ok(records.every(row => row.correctedName === "Latest correction"));
    assert.equal(store.getUserSong("work").name, "Display alias");
  } finally { clearTimeout(deadline); gate.resolve(); await manager.close?.(); }
}));

test("startup restores the durable title without hashing, then resumes pending legacy identity work after start", async () => fixture(async ({ root, store, input }) => {
  installLegacy(store, input);
  store.updateUserSongMetadata("work", { permanentName: "Survives restart" });
  const gate = deferred();
  const resolver = slowResolver(gate);
  const manager = await createSongNameCorrections({ root, store, resolveSongPreview: resolver });
  try {
    assert.equal(manager.status("work").state, "pending");
    assert.deepEqual(resolver.calls, []);
    manager.start();
    gate.resolve();
    await manager.whenIdle();
    assert.equal(manager.status("work").state, "synced");
    assert.equal(store.getUserSong("work").name, "Survives restart");
  } finally { gate.resolve(); await manager.close?.(); }
}));

test("deleting a work while hashing does not resurrect it or attach an obsolete alias", async () => fixture(async ({ root, store, input }) => {
  installLegacy(store, input);
  const gate = deferred();
  const manager = await createSongNameCorrections({ root, store, resolveSongPreview: slowResolver(gate) });
  try {
    await manager.save("work", { permanentName: "Kept correction" });
    store.deleteUserSong("work");
    gate.resolve();
    await manager.whenIdle();
    assert.equal(store.getUserSong("work"), null);
    assert.equal(store.listSongNameCorrections().length, 1);
  } finally { gate.resolve(); await manager.close?.(); }
}));

test("close cancels the background wait without losing the already flushed correction", async () => fixture(async ({ root, store, file, input }) => {
  installLegacy(store, input);
  const gate = deferred();
  const resolver = slowResolver(gate);
  const manager = await createSongNameCorrections({ root, store, resolveSongPreview: resolver });
  try {
    await manager.save("work", { permanentName: "Durable title" });
    while (!resolver.calls.length) await new Promise(resolve => setImmediate(resolve));
    await manager.close();
    assert.equal(JSON.parse(await readFile(file, "utf8")).records[0].correctedName, "Durable title");
    await assert.rejects(manager.save("work", { permanentName: "Too late" }), /closed/u);
  } finally { gate.resolve(); await manager.close?.(); }
}));
