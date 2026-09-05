import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const [app, patch, editor] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8"),
  readFile(new URL("../public/song-editor.js", import.meta.url), "utf8"),
]);

test("admin row opens the same stable work ID and applies save to cached records", () => {
  const entry = app.match(/function openMidiSongEditor\(songId\) \{[\s\S]*?\n\}/u)?.[0] || "";
  const rows = [{ id: "work-1", name: "Old" }, { id: "other", name: "Old" }]; let opened, rendered;
  const window = { document: {} };
  const context = vm.createContext({ window, midiStatusSnapshot: { songs: rows }, renderMidiStatus(data) { rendered = data; } });
  vm.runInContext(editor, context); window.OliviaSoulSongEditor.open = options => { opened = options; };
  vm.runInContext(entry, context);
  assert.equal(typeof context.openMidiSongEditor, "function");
  context.openMidiSongEditor("work-1");
  assert.equal(opened.songId, "work-1"); assert.equal(opened.baseUrl, "/admin/api");
  opened.onSaved({ id: "work-1", name: "New" });
  assert.equal(rows[0].name, "New"); assert.equal(rows[1].name, "Old"); assert.equal(rendered.songs, rows);
});

test("game editor rejects official rows and uses decoded local stable IDs without play commands", () => {
  const entry = patch.match(/\$songEditorBridge = @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1] || "";
  const opened = [], window = { document: {} };
  const context = vm.createContext({ window }); vm.runInContext(editor, context);
  window.OliviaSoulSongEditor.open = options => opened.push(options);
  vm.runInContext(entry.replaceAll("__OLIVIA_SONG_EDITOR_BASE__", "http://fixture.test/toy"), context);
  assert.equal(typeof context.OliviaSoulEditSong, "function");
  context.OliviaSoulEditSong({ id: "official", videoUrl: "https://media.test/official.mp4" });
  context.OliviaSoulEditSong({ id: "playlist-entry", videoUrl: "http://fixture.test/toy/midi/songs/work%2F42/video" });
  assert.equal(opened.length, 1); assert.equal(opened[0].songId, "work/42"); assert.equal(opened[0].baseUrl, "http://fixture.test/toy");
});

test("game current and playlist titles update by ID without touching playing state", () => {
  const sync = patch.match(/\$songTitleSync = @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1] || "";
  const current = { id: "work", videoUrl: "/toy/midi/songs/work/video", name: "Old" };
  const playlist = [{ itemId: "entry", videoUrl: "/toy/midi/songs/work/video", name: "Old" }, { itemId: "other", name: "Old" }];
  const window = { document: {}, addEventListener() {}, __OliviaSoulSessionId: "session", __OliviaSoulSessionEpoch: 8 };
  const context = vm.createContext({ window, x: { value: playlist }, u: { value: null }, f: { value: current }, setInterval() {}, fetch() { throw new Error("no playback or fetch during rename"); } });
  vm.runInContext(editor, context); vm.runInContext(sync.replaceAll("__OLIVIA_SONG_EDITOR_BASE__", "http://fixture.test/toy"), context);
  assert.equal(typeof context.OliviaSoulApplySongMetadata, "function"); context.OliviaSoulApplySongMetadata({ id: "work", name: "New" });
  assert.equal(current.name, "New"); assert.equal(playlist[0].name, "New"); assert.equal(playlist[1].name, "Old");
  assert.equal(window.__OliviaSoulSessionId, "session"); assert.equal(window.__OliviaSoulSessionEpoch, 8);
});

test("game upload and playlist caches receive editor saves in place", () => {
  const sync = patch.match(/\$songUploadMetadata = @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1] || "";
  const song = { id: "work", name: "Old" }, item = { itemId: "entry", videoUrl: "/toy/midi/songs/work/video", name: "Old" };
  const window = { document: {} }; let metadata;
  const context = vm.createContext({ window, he: { value: [song] }, K: { value: [item] }, h: { applySongMetadata(value) { metadata = value; } } });
  vm.runInContext(editor, context); vm.runInContext(sync, context);
  assert.equal(typeof context.OliviaSoulUploadMetadata, "function");
  context.OliviaSoulUploadMetadata({ detail: { id: "work", name: "New" } });
  assert.equal(song.name, "New"); assert.equal(item.name, "New"); assert.equal(metadata.id, "work");
});

test("current session duration updates both songlist and playlist display without changing identity", () => {
  const store = patch.match(/^\$playerStateStoreTo = '([^\r\n]*)'\r?$/mu)?.[1] || "";
  const apply = store.match(/OliviaSoulApplyPlayerState=(B=>\{[\s\S]*?\}),OliviaSoulEnsurePlayerPoll=/u)?.[1];
  assert.ok(apply);
  const current = { id: "work", duration: 1, videoDuration: 1 }, songlist = { id: "work", duration: 1, videoDuration: 1 };
  const window = { document: {}, __OliviaSoulSongId: "work", __OliviaSoulSessionId: "session" };
  const context = vm.createContext({ window, u: { value: current }, f: { value: songlist }, d: { value: 5 }, m: { value: true } });
  vm.runInContext(editor, context);
  context.apply = vm.runInContext(`(${apply})`, context);
  context.apply({ songId: "work", sessionId: "old", playbackState: "playing", duration: 99, currentTime: 5 });
  assert.equal(current.duration, 1);
  context.apply({ songId: "work", sessionId: "session", playbackState: "playing", duration: 367.5, currentTime: 5 });
  assert.equal(current.duration, 367.5); assert.equal(current.videoDuration, 367.5); assert.equal(songlist.duration, 367.5);
  assert.equal(current.id, "work"); assert.equal(window.__OliviaSoulSessionId, "session");
});

test("current playlist duration cannot overwrite a stale songlist object from another work", () => {
  const store = patch.match(/^\$playerStateStoreTo = '([^\r\n]*)'\r?$/mu)?.[1] || "";
  const apply = store.match(/OliviaSoulApplyPlayerState=(B=>\{[\s\S]*?\}),OliviaSoulEnsurePlayerPoll=/u)?.[1];
  assert.ok(apply);
  const current = { itemId: "playlist-entry", videoUrl: "/toy/midi/songs/work-A/video", duration: 1, videoDuration: 1 };
  const staleSonglist = { id: "work-B", videoUrl: "/toy/midi/songs/work-B/video", duration: 90, videoDuration: 90 };
  const window = { document: {}, __OliviaSoulSongId: "work-A", __OliviaSoulSessionId: "session-A" };
  const context = vm.createContext({ window, u: { value: current }, f: { value: staleSonglist }, d: { value: 5 }, m: { value: true } });
  vm.runInContext(editor, context);
  const handler = vm.runInContext(`(${apply})`, context);
  handler({ songId: "work-A", sessionId: "session-A", playbackState: "playing", duration: 367.5, currentTime: 5 });
  assert.equal(current.duration, 367.5); assert.equal(current.videoDuration, 367.5);
  assert.equal(staleSonglist.duration, 90); assert.equal(staleSonglist.videoDuration, 90);
  assert.equal(current.itemId, "playlist-entry"); assert.equal(window.__OliviaSoulSessionId, "session-A");
});
