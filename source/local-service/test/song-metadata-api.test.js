import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOliviaService } from "../server.js";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-metadata-api-"));
  let clock = new Date(2026, 8, 4, 12, 0);
  const service = await createOliviaService({
    root, dataDir: join(root, "data"), officialMediaRoot: join(root, "media"),
    worker: false, runMemoryRefresh: false,
    playbackNow: () => clock, midiDurationProbe: async () => 120_000_000, ...options,
  });
  const address = await service.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const json = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  };
  await mkdir(join(service.midiStore.root, "outputs"), { recursive: true });
  const paths = {};
  for (const [key, contents] of Object.entries({ TOD12: "DAY", TOD1730: "EVENING", TOD20: "NIGHT" })) {
    paths[key] = join(service.midiStore.root, "outputs", key + ".mp4");
    await writeFile(paths[key], contents);
  }
  const song = service.midiStore.upsertUserSong({
    id: "metadata-work", name: "原曲名", sourceKind: "official-import", videoPath: paths.TOD12,
    videoByTodView: paths, durationUs: 120_000_000, contentHash: "a".repeat(64),
  });
  return {
    service, song, base, json, root,
    clock: (hour, minute = 0) => { clock = new Date(2026, 8, 4, hour, minute); },
    play: () => json("/toy/player-command", {
      cmd: "play", songId: song.id, name: "STALE CLIENT TITLE",
      url: `${base}/toy/midi/songs/${song.id}/video.mp4`,
    }),
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("permanent API saves persist a portable correction and restore to that baseline without playback effects", async () => {
  const ctx = await fixture();
  try {
    const started = (await ctx.play()).data;
    const endpoint = `/admin/api/media/songs/${ctx.song.id}/metadata`;
    const saved = await ctx.json(endpoint, { permanentName: "Correct title" });
    assert.equal(saved.code, 0);
    assert.equal(saved.data.correctedName, "Correct title");
    assert.deepEqual(saved.data.nameSync, { state: "synced", error: null });
    assert.equal(saved.data.originalName, "原曲名");
    const document = JSON.parse(await readFile(join(ctx.root, "settings", "song-name-corrections.json"), "utf8"));
    assert.equal(document.records[0].correctedName, "Correct title");
    assert.equal(JSON.stringify(document).includes(ctx.root), false);
    await ctx.json(endpoint, { name: "Display" });
    assert.equal((await ctx.json(endpoint, { name: null })).data.name, "Correct title");
    assert.equal((await ctx.json(`/toy/media/songs/${ctx.song.id}/metadata`)).data.correctedName, "Correct title");
    assert.deepEqual((await ctx.json("/toy/player-command")).data, started);
  } finally { await ctx.close(); }
});

test("permanent API exposes projection failure with durable DB title and allows explicit retry", async () => {
  const ctx = await fixture();
  try {
    const target = join(ctx.root, "settings", "song-name-corrections.json");
    await mkdir(target, { recursive: true });
    const endpoint = `/toy/media/songs/${ctx.song.id}/metadata`;
    const saved = await ctx.json(endpoint, { permanentName: "Saved in database" });
    assert.equal(saved.code, 0);
    assert.equal(saved.data.name, "Saved in database");
    assert.equal(saved.data.nameSync.state, "failed");
    assert.ok(saved.data.nameSync.error);
    assert.equal((await ctx.json(endpoint)).data.nameSync.state, "failed");
    await rm(target, { recursive: true });
    const retried = await ctx.json(endpoint, { permanentName: "Saved in database" });
    assert.equal(retried.data.nameSync.state, "synced");
  } finally { await ctx.close(); }
});

test("metadata aliases rename one work in uploads and playlist without replaying the active session", async () => {
  const ctx = await fixture();
  try {
    await ctx.json("/toy/addToPlaylist", { itemType: 3, itemId: ctx.song.id, name: "原曲名" });
    const started = (await ctx.play()).data;
    await ctx.json("/toy/player-state", {
      songId: ctx.song.id, sessionId: started.command.sessionId, mediaUrl: started.command.url,
      commandRevision: started.revision, event: "timeupdate", currentTime: 31, duration: 120,
    });
    const before = (await ctx.json("/toy/player-state")).data;
    const saved = await ctx.json(`/admin/api/media/songs/${ctx.song.id}/metadata`, { name: "新的名称" });
    assert.equal(saved.code, 0);
    assert.equal(saved.data.name, "新的名称");
    assert.equal(saved.data.originalName, "原曲名");
    assert.equal((await ctx.json(`/toy/media/songs/${ctx.song.id}/metadata`)).data.name, "新的名称");
    assert.equal((await ctx.json("/toy/searchPlaylist")).data.list[0].name, "新的名称");
    const list = (await ctx.json("/toy/searchUserSongs?query=" + encodeURIComponent("新的名称"))).data.list;
    assert.equal(list[0].id, ctx.song.id);
    assert.deepEqual((await ctx.json("/toy/player-command")).data, started);
    const after = (await ctx.json("/toy/player-state")).data;
    for (const key of ["sessionId", "mediaUrl", "currentTime", "commandRevision", "playbackState"]) {
      assert.equal(after[key], before[key], key);
    }
    assert.equal(after.name, "新的名称");
    const restored = await ctx.json(`/toy/media/songs/${ctx.song.id}/metadata`, { name: null });
    assert.equal(restored.code, 0);
    assert.equal(restored.data.name, "原曲名");
  } finally { await ctx.close(); }
});

test("play starts use native local-clock boundaries and never change a running session at a boundary", async () => {
  const ctx = await fixture();
  try {
    for (const [hour, minute, variant, contents] of [
      [5, 59, "TOD20", "NIGHT"], [6, 0, "TOD12", "DAY"], [15, 59, "TOD12", "DAY"],
      [16, 0, "TOD1730", "EVENING"], [19, 59, "TOD1730", "EVENING"], [20, 0, "TOD20", "NIGHT"],
    ]) {
      ctx.clock(hour, minute);
      const started = await ctx.play();
      assert.equal(started.code, 0);
      assert.equal(started.data.command.name, "原曲名", "server title is authoritative");
      assert.equal(new URL(started.data.command.url).searchParams.get("variant"), variant);
      assert.equal(await fetch(started.data.command.url).then(r => r.text()), contents);
      ctx.clock(12);
      assert.deepEqual((await ctx.json("/toy/player-command")).data, started.data);
    }
  } finally { await ctx.close(); }
});

test("metadata validates IDs and fields and forbids registering arbitrary variant paths", async () => {
  const ctx = await fixture();
  try {
    const endpoint = `/admin/api/media/songs/${ctx.song.id}/metadata`;
    assert.equal((await ctx.json(endpoint, { name: "" })).status, 400);
    assert.equal((await ctx.json(endpoint, { videoPath: "unregistered.mp4" })).status, 400);
    assert.equal((await ctx.json(endpoint, { timeOfDayMapping: { TOD12: "../unknown.mp4" } })).status, 400);
    assert.equal((await ctx.json("/admin/api/media/songs/missing/metadata")).status, 404);
    assert.equal((await ctx.json(endpoint)).data.name, "原曲名");
    const changed = await ctx.json(endpoint, { timeOfDayMapping: { TOD12: "TOD20" } });
    assert.equal(changed.code, 0);
    const started = await ctx.play();
    assert.equal(await fetch(started.data.command.url).then(r => r.text()), "NIGHT");
  } finally { await ctx.close(); }
});

test("editor preview has independent HEAD, Range and real missing-media status without playback commands", async () => {
  const ctx = await fixture();
  try {
    const before = (await ctx.json("/toy/player-command")).data;
    const metadata = (await ctx.json(`/toy/media/songs/${ctx.song.id}/metadata`)).data;
    const video = metadata.variants.find(item => item.key === "TOD1730").url;
    assert.match(video, /\/toy\/media\/songs\/metadata-work\/preview\.mp4\?variant=TOD1730$/u);
    const head = await fetch(video, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("Content-Type"), "video/mp4");
    assert.equal(head.headers.get("Content-Length"), "7"); assert.equal(await head.text(), "");
    const partial = await fetch(video, { headers: { Range: "bytes=2-4" } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get("Content-Range"), "bytes 2-4/7");
    assert.equal(await partial.text(), "ENI");
    const missing = await fetch(video.replace("TOD1730", "UNKNOWN"));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "MEDIA_PREVIEW_UNAVAILABLE");
    assert.deepEqual((await ctx.json("/toy/player-command")).data, before);
  } finally { await ctx.close(); }
});

for (const trigger of ["watch", "rescan"]) test(`preview source cache refreshes after an explicit ${trigger} event inside an existing work folder`, async () => {
  const watches = [];
  const ctx = await fixture({ midiLibraryWatchFactory: options => { watches.push(options); return { close() {} }; } });
  try {
    const library = join(ctx.root, "watched-library");
    const folder = join(library, "Preview work");
    await mkdir(folder, { recursive: true });
    const preview = await ctx.json("/admin/api/midi-library/preview", { root: library });
    await ctx.json("/admin/api/midi-library/confirm", { previewId: preview.data.previewId });
    const fileHash = createHash("sha256").update("ORIGINAL CLIP").digest("hex");
    const workHash = createHash("sha256").update(`DEFAULT\0${fileHash}\0`).digest("hex");
    const song = ctx.service.midiStore.upsertUserSong({ name: "Preview work", sourceKind: "import", contentHash: workHash,
      videoPath: "missing-preview.mp4", videoByTodView: { DEFAULT: "missing-preview.mp4" } });
    const url = `${ctx.base}/toy/media/songs/${song.id}/preview.mp4?variant=DEFAULT`;
    assert.equal((await fetch(url)).status, 404);
    await writeFile(join(folder, "take.mp4"), "ORIGINAL CLIP");
    if (trigger === "watch") await watches[0].onChange();
    else await ctx.json("/admin/api/midi-library/preview", { root: library });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ORIGINAL CLIP");
  } finally { await ctx.close(); }
});

test("stale cache preview recovers source clips by work fingerprint, not filename order or customized name", async () => {
  const ctx = await fixture();
  try {
    const library = join(ctx.service.midiStore.root, "import-source");
    await mkdir(join(library, "work"), { recursive: true });
    await writeFile(join(library, "work", "z.mp4"), "DAY ORIGINAL");
    await writeFile(join(library, "work", "a.mp4"), "EVENING ORIGINAL");
    await writeFile(join(library, "library.json"), JSON.stringify({ songs: [{ name: "Source title", variants: { DEFAULT: "work/z.mp4", ALT_2: "work/a.mp4" } }] }));
    const hash = createHash("sha256").update("DAY ORIGINAL").digest("hex");
    const stale = join(ctx.service.midiStore.root, ".faststart-cache", hash);
    const song = ctx.service.midiStore.upsertUserSong({ name: "Source title", sourceKind: "import", contentHash: hash,
      videoPath: join(stale, "DEFAULT.mp4"), videoByTodView: { DEFAULT: join(stale, "DEFAULT.mp4"), ALT_2: join(stale, "ALT_2.mp4") }, durationUs: 120_000_000 });
    ctx.service.midiStore.updateUserSongMetadata(song.id, { name: "Custom title", timeOfDayMapping: { TOD12: "ALT_2" } });
    ctx.service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(library);
    const before = ctx.service.midiStore.getUserSong(song.id);
    const metadata = (await ctx.json(`/admin/api/media/songs/${song.id}/metadata`)).data;
    assert.equal(await fetch(metadata.variants.find(item => item.key === "ALT_2").url).then(r => r.text()), "EVENING ORIGINAL");
    assert.deepEqual(ctx.service.midiStore.getUserSong(song.id), before);
  } finally { await ctx.close(); }
});

test("legacy permanent correction acknowledges durable name first and links originals in background after retry", async () => {
  const ctx = await fixture();
  try {
    const library = join(ctx.root, "legacy-source");
    await mkdir(join(library, "work"), { recursive: true });
    await writeFile(join(library, "work", "z.mp4"), "DAY ORIGINAL");
    await writeFile(join(library, "work", "a.mp4"), "EVENING ORIGINAL");
    await writeFile(join(library, "library.json"), JSON.stringify({ songs: [{ name: "Source title", variants: { DEFAULT: "work/z.mp4", ALT_2: "work/a.mp4" } }] }));
    const hash = createHash("sha256").update("DAY ORIGINAL").digest("hex");
    const stale = join(ctx.service.midiStore.root, ".faststart-cache", hash);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "DEFAULT.mp4"), "TRANSFORMED CACHE");
    await writeFile(join(stale, "ALT_2.mp4"), "TRANSFORMED CACHE TWO");
    const song = ctx.service.midiStore.upsertUserSong({ name: "Source title", sourceKind: "import", contentHash: hash,
      videoPath: join(stale, "DEFAULT.mp4"), videoByTodView: { DEFAULT: join(stale, "DEFAULT.mp4"), ALT_2: join(stale, "ALT_2.mp4") } });
    const endpoint = `/admin/api/media/songs/${song.id}/metadata`;
    const waitState = async expected => {
      for (let attempts = 0; attempts < 300; attempts++) {
        const result = await ctx.json(endpoint);
        if (result.data.nameSync.state === expected) return result;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`background name sync did not reach ${expected}`);
    };
    const acknowledged = await ctx.json(endpoint, { permanentName: "Correction" });
    assert.equal(acknowledged.data.name, "Correction");
    assert.ok(["pending", "failed"].includes(acknowledged.data.nameSync.state));
    const records = JSON.parse(await readFile(join(ctx.root, "settings", "song-name-corrections.json"), "utf8")).records;
    assert.equal(records.find(row => row.fingerprint === hash).correctedName, "Correction");
    await waitState("failed"); // Cache bytes cannot substitute for verified originals.
    ctx.service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(library);
    await ctx.json(endpoint, { permanentName: "Correction" });
    await waitState("synced");
    const newHash = createHash("sha256")
      .update(`ALT_2\0${createHash("sha256").update("EVENING ORIGINAL").digest("hex")}\0`)
      .update(`DEFAULT\0${hash}\0`).digest("hex");
    ctx.service.midiStore.deleteUserSong(song.id);
    const restored = ctx.service.midiStore.upsertUserSong({ id: "new-identity", name: "Source title", sourceKind: "import", contentHash: newHash });
    assert.equal(restored.name, "Correction");
    assert.equal(restored.originalName, "Source title");
    await ctx.json(`/admin/api/media/songs/${restored.id}/metadata`, { permanentName: "Second correction" });
    ctx.service.midiStore.deleteUserSong(restored.id);
    assert.equal(ctx.service.midiStore.upsertUserSong({ name: "Source title", sourceKind: "import", contentHash: hash }).name, "Second correction");
  } finally { await ctx.close(); }
});

test("selected file duration is verified independently without trusting a stale two-second video event", async () => {
  const ctx = await fixture({ midiDurationProbe: async path => path.endsWith("TOD20.mp4") ? 150_000_000 : 100_000_000 });
  try {
    for (const [hour, expected] of [[21, 150], [12, 100]]) {
      ctx.clock(hour);
      const started = (await ctx.play()).data;
      let state;
      for (let attempts = 0; attempts < 60; attempts++) {
        state = (await ctx.json("/toy/player-state")).data;
        if (state.duration === expected) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(state.duration, expected, "selected MP4, not the default work duration");
      const postState = extra => ctx.json("/toy/player-state", {
        commandRevision: started.revision, sessionId: started.command.sessionId,
        songId: ctx.song.id, mediaUrl: started.command.url, ...extra,
      });
      const stale = await postState({ event: "ended", duration: 2, currentTime: 2 });
      assert.equal(stale.data.playbackState, "playing");
      const actual = await postState({ event: "timeupdate", duration: expected, currentTime: expected - 5 });
      assert.equal(actual.data.playbackState, "playing");
      const ended = await postState({ event: "ended", duration: expected, currentTime: expected });
      assert.equal(ended.data.playbackState, "ended");
    }
  } finally { await ctx.close(); }
});

test("a seek invalidates an old near-end sample while the selected file is still being verified", async () => {
  let finishProbe;
  const probe = new Promise(resolve => { finishProbe = resolve; });
  const ctx = await fixture({ midiDurationProbe: () => probe });
  try {
    ctx.clock(21);
    const started = (await ctx.play()).data;
    await ctx.json("/toy/player-state", {
      songId: ctx.song.id, sessionId: started.command.sessionId, mediaUrl: started.command.url,
      commandRevision: started.revision, event: "timeupdate", currentTime: 149.9, duration: 150,
    });
    await ctx.json("/toy/player-command", { cmd: "seek", songId: ctx.song.id, sessionId: started.command.sessionId, offset: 0 });
    finishProbe(150_000_000);
    let state;
    for (let attempts = 0; attempts < 60; attempts++) {
      state = (await ctx.json("/toy/player-state")).data;
      if (state.duration === 150) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state.duration, 150);
    assert.equal(state.playbackState, "playing");
    assert.equal(state.currentTime, 0);
  } finally { finishProbe(150_000_000); await ctx.close(); }
});

test("a failed duration probe still processes a deferred ending at the registered duration", async () => {
  let failProbe;
  const probe = new Promise((_, reject) => { failProbe = reject; });
  probe.catch(() => {});
  const ctx = await fixture({ midiDurationProbe: () => probe });
  try {
    ctx.clock(21);
    const started = (await ctx.play()).data;
    await ctx.json("/toy/player-state", {
      songId: ctx.song.id, sessionId: started.command.sessionId, mediaUrl: started.command.url,
      commandRevision: started.revision, event: "ended", currentTime: 120, duration: 120,
    });
    failProbe(new Error("test probe failure"));
    let state;
    for (let attempts = 0; attempts < 60; attempts++) {
      state = (await ctx.json("/toy/player-state")).data;
      if (state.playbackState === "ended") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state.playbackState, "ended");
  } finally { failProbe(new Error("fixture closed")); await ctx.close(); }
});
