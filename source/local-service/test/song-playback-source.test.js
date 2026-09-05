import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createOliviaService } from "../server.js";

const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "olivia-playback-source-"));
  const service = await createOliviaService({
    root, dataDir: join(root, "data"), appData: join(root, "app-data"),
    runtimeDir: join(root, "runtime"), officialMediaRoot: join(root, "media"),
    worker: false, runMemoryRefresh: false,
    playbackNow: () => new Date(2026, 8, 4, 21, 0),
    midiDurationProbe: async () => 120_000_000,
    fetch: async () => { throw new Error("External requests are forbidden in playback source tests"); },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const address = await service.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const json = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  };
  const videoUrl = (id, variant) => `${base}/toy/midi/songs/${encodeURIComponent(id)}/video.mp4`
    + (variant ? `?variant=${encodeURIComponent(variant)}` : "");
  const play = song => json("/toy/player-command", {
    cmd: "play", songId: song.id, name: "stale client title", url: videoUrl(song.id),
  });
  const playback = async () => ({
    command: (await json("/toy/player-command")).data,
    state: (await json("/toy/player-state")).data,
  });
  const storedIdentity = id => ({ ...service.db.prepare(`
    SELECT id, content_hash, video_path, video_by_tod_view, time_of_day_mapping
    FROM user_songs WHERE id = ?
  `).get(id) });
  return { root, service, base, json, videoUrl, play, playback, storedIdentity };
}

async function legacySong(ctx, { missing = false, wrongIdentity = false } = {}) {
  const library = join(ctx.root, "library");
  await mkdir(join(library, "work"), { recursive: true });
  // Manifest keys deliberately disagree with filename sort order.
  const variants = { DEFAULT: "work/z.mp4", ALT_2: "work/a.mp4", ALT_3: "work/m.mp4" };
  const contents = { DEFAULT: "DAY ORIGINAL", ALT_2: "EVENING ORIGINAL", ALT_3: "NIGHT ORIGINAL" };
  if (!missing) for (const [key, relative] of Object.entries(variants))
    await writeFile(join(library, relative), contents[key]);
  await writeFile(join(library, "library.json"), JSON.stringify({ songs: [{ name: "Original title", variants }] }));
  const contentHash = hash(wrongIdentity ? "ANOTHER WORK" : contents.DEFAULT);
  const cachePaths = Object.fromEntries(Object.keys(variants).map(key => [
    key, join(ctx.service.midiStore.root, ".faststart-cache", contentHash, `${key}.mp4`),
  ]));
  const song = ctx.service.midiStore.upsertUserSong({
    id: "legacy-work", name: "Original title", sourceKind: "import", contentHash,
    videoPath: cachePaths.DEFAULT, videoByTodView: cachePaths, durationUs: 120_000_000,
  });
  ctx.service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(library);
  return { song, library, variants, contents, cachePaths };
}

async function directSong(ctx) {
  const path = join(ctx.service.midiStore.root, "outputs", "direct.mp4");
  await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
  await writeFile(path, "DIRECT VIDEO");
  return ctx.service.midiStore.upsertUserSong({
    id: "direct-work", name: "Direct work", sourceKind: "official-import",
    videoPath: path, videoByTodView: { DEFAULT: path }, durationUs: 120_000_000,
  });
}

test("actual playback recovers the mapped legacy source after two permanent renames without rewriting identity or paths", async t => {
  const ctx = await fixture(t);
  const source = await legacySong(ctx);
  const endpoint = `/admin/api/media/songs/${source.song.id}/metadata`;
  assert.equal((await ctx.json(endpoint, { timeOfDayMapping: { TOD12: "DEFAULT", TOD1730: "ALT_2", TOD20: "ALT_3" } })).code, 0);
  const identity = ctx.storedIdentity(source.song.id);
  for (const name of ["First correction", "Second correction"]) {
    const result = await ctx.json(endpoint, { permanentName: name });
    assert.equal(result.code, 0);
    assert.equal(result.data.name, name);
    assert.equal(result.data.originalName, "Original title");
  }
  const started = await ctx.play(source.song);
  assert.equal(started.code, 0);
  const command = started.data.command;
  assert.equal(command.name, "Second correction");
  assert.equal(command.songId, "legacy-work");
  assert.equal(new URL(command.url).pathname, "/toy/midi/songs/legacy-work/video.mp4");
  assert.equal(new URL(command.url).searchParams.get("variant"), "ALT_3");
  assert.equal(new URL(command.url).searchParams.get("playSession"), command.sessionId);
  const head = await fetch(command.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Type"), "video/mp4");
  assert.equal(head.headers.get("Content-Length"), "14");
  assert.equal(await head.text(), "");
  const partial = await fetch(command.url, { headers: { Range: "bytes=0-4" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 0-4/14");
  assert.equal(await partial.text(), "NIGHT");
  assert.equal(await fetch(command.url).then(response => response.text()), "NIGHT ORIGINAL");
  for (const [key, expected] of Object.entries(source.contents)) {
    const response = await fetch(ctx.videoUrl(source.song.id, key));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), expected, key);
    assert.equal(await readFile(join(source.library, source.variants[key]), "utf8"), expected);
    await assert.rejects(stat(source.cachePaths[key]), { code: "ENOENT" });
  }
  // A cache appearing during playback must not change the source behind existing byte offsets.
  await mkdir(dirname(source.cachePaths.ALT_3), { recursive: true });
  await writeFile(source.cachePaths.ALT_3, "LATE TRANSFORMED CACHE");
  const pinnedHead = await fetch(command.url, { method: "HEAD" });
  assert.equal(pinnedHead.status, 200);
  assert.equal(pinnedHead.headers.get("Content-Length"), "14");
  const pinnedRange = await fetch(command.url, { headers: { Range: "bytes=6-13" } });
  assert.equal(pinnedRange.status, 206);
  assert.equal(pinnedRange.headers.get("Content-Range"), "bytes 6-13/14");
  assert.equal(await pinnedRange.text(), "ORIGINAL");
  assert.equal(await fetch(command.url).then(response => response.text()), "NIGHT ORIGINAL");
  // A URL without an explicit variant still means the registered default, not the current clock slot.
  assert.equal(await fetch(ctx.videoUrl(source.song.id)).then(response => response.text()), "DAY ORIGINAL");
  assert.deepEqual(ctx.storedIdentity(source.song.id), identity);
  assert.deepEqual((await ctx.json("/toy/player-command")).data, started.data);
});

test("missing playback media returns real HEAD and GET 404 and rejects play before replacing an active session", async t => {
  const ctx = await fixture(t);
  const active = await directSong(ctx);
  assert.equal((await ctx.play(active)).code, 0);
  const source = await legacySong(ctx, { missing: true });
  const before = await ctx.playback();
  const identity = ctx.storedIdentity(source.song.id);
  const head = await fetch(ctx.videoUrl(source.song.id, "DEFAULT"), { method: "HEAD" });
  const get = await fetch(ctx.videoUrl(source.song.id, "DEFAULT"));
  const body = await get.json();
  const started = await ctx.play(source.song);
  const after = await ctx.playback();
  assert.deepEqual({
    headStatus: head.status, getStatus: get.status, mediaRejected: body.code !== 0,
    playRejected: started.code !== 0, commandUnchanged: JSON.stringify(after.command) === JSON.stringify(before.command),
    stateUnchanged: JSON.stringify(after.state) === JSON.stringify(before.state),
  }, { headStatus: 404, getStatus: 404, mediaRejected: true, playRejected: true, commandUnchanged: true, stateUnchanged: true });
  assert.deepEqual(ctx.storedIdentity(source.song.id), identity);
});

test("same title and filenames cannot recover a different work and an unknown variant never falls back to a present default", async t => {
  const ctx = await fixture(t);
  const source = await legacySong(ctx, { wrongIdentity: true });
  const direct = await directSong(ctx);
  const before = await ctx.playback();
  const identity = ctx.storedIdentity(source.song.id);
  const mediaResults = [];
  for (const [song, variant] of [[source.song, "DEFAULT"], [source.song, "ALT_3"], [direct, "UNKNOWN"]]) {
    for (const method of ["HEAD", "GET"]) {
      const response = await fetch(ctx.videoUrl(song.id, variant), { method });
      const body = method === "GET" ? await response.json() : null;
      mediaResults.push({ method, variant, status: response.status, rejected: body ? body.code !== 0 : true });
    }
  }
  const started = await ctx.play(source.song);
  const after = await ctx.playback();
  assert.deepEqual(mediaResults, [
    { method: "HEAD", variant: "DEFAULT", status: 404, rejected: true },
    { method: "GET", variant: "DEFAULT", status: 404, rejected: true },
    { method: "HEAD", variant: "ALT_3", status: 404, rejected: true },
    { method: "GET", variant: "ALT_3", status: 404, rejected: true },
    { method: "HEAD", variant: "UNKNOWN", status: 404, rejected: true },
    { method: "GET", variant: "UNKNOWN", status: 404, rejected: true },
  ]);
  assert.notEqual(started.code, 0);
  assert.deepEqual(after, before);
  assert.deepEqual(ctx.storedIdentity(source.song.id), identity);
});

test("an existing registered video plays without a configured import library", async t => {
  const ctx = await fixture(t);
  const song = await directSong(ctx);
  assert.equal(ctx.service.db.prepare("SELECT value FROM settings WHERE key = 'midi_library_root'").get(), undefined);
  const identity = ctx.storedIdentity(song.id);
  const started = await ctx.play(song);
  assert.equal(started.code, 0);
  const url = started.data.command.url;
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Type"), "video/mp4");
  assert.equal(head.headers.get("Content-Length"), "12");
  assert.equal(await fetch(url).then(response => response.text()), "DIRECT VIDEO");
  const partial = await fetch(url, { headers: { Range: "bytes=7-11" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 7-11/12");
  assert.equal(await partial.text(), "VIDEO");
  assert.equal(await fetch(ctx.videoUrl(song.id)).then(response => response.text()), "DIRECT VIDEO");
  assert.deepEqual(ctx.storedIdentity(song.id), identity);
});
