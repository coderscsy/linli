import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOliviaService } from "../server.js";
import { blockedFetchPorts } from "./fixtures/fetch-ports.js";
import { endOfTrack, midiFile, noteOff, noteOn, track } from "./fixtures/midi-fixtures.js";

async function apiFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-midi-api-"));
  const enqueued = [];
  const service = await createOliviaService({
    root,
    dataDir: join(root, "data"),
    worker: false,
    runMemoryRefresh: false,
    midiQueue: { enqueue: id => enqueued.push(id) },
    officialMediaRoot: join(root, "official-media"),
    ...options,
  });
  let address = await service.listen(0);
  while (blockedFetchPorts.has(address.port)) {
    await new Promise(resolve => service.server.close(resolve));
    address = await service.listen(0);
  }
  const base = `http://127.0.0.1:${address.port}`;
  async function json(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    root,
    base,
    service,
    enqueued,
    json,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("local MIDI API rejects new keyboard-only generation without creating records", async () => {
  const ctx = await apiFixture();
  try {
    const signed = await ctx.json("/toy/genObjectUploadUrl", {
      method: "POST",
      body: JSON.stringify({ type: "midi", filename: "水边的阿狄丽娜.midi" }),
    });
    assert.equal(signed.status, 200, "game-compatible /toy endpoints keep HTTP 200");
    assert.equal(signed.body.code, "MIDI_RENDERING_DISABLED");
    assert.match(signed.body.message, /人物演奏/u);
    assert.equal(ctx.service.midiStore.listJobs().length, 0);

    const generated = await ctx.json("/toy/midi/generate", {
      method: "POST",
      body: JSON.stringify({ midiUrl: "uploads/legacy/source.mid", filename: "水边的阿狄丽娜" }),
    });
    assert.equal(generated.body.code, "MIDI_RENDERING_DISABLED");
    assert.equal(ctx.service.midiStore.listJobs().length, 0);
    assert.deepEqual(ctx.enqueued, []);
  } finally {
    await ctx.close();
  }
});

test("local MIDI API supports result lookup, batch lookup, cancellation, and idempotent deletion", async () => {
  const ctx = await apiFixture();
  try {
    const input = midiFile({ tracks: [track(endOfTrack())] });
    const upload = ctx.service.midiStore.createUploadToken({ originalFilename: "cancel.mid" });
    const inputPath = join(ctx.service.midiStore.root, "inputs", "cancel.mid");
    await mkdir(join(ctx.service.midiStore.root, "inputs"), { recursive: true });
    await writeFile(inputPath, input);
    ctx.service.midiStore.consumeUploadToken(upload.token, {
      inputPath,
      sha256: createHash("sha256").update(input).digest("hex"),
      sizeBytes: input.length,
    });
    const jobId = ctx.service.midiStore.createJob({ uploadKey: upload.key, title: "Cancel" }).id;

    const result = await ctx.json(`/midi/getGenerateResult?jobId=${jobId}`);
    assert.equal(result.body.data.jobId, jobId);
    const batch = await ctx.json("/midi/batchGetResult", {
      method: "POST",
      body: JSON.stringify({ jobIds: [jobId, "missing"] }),
    });
    assert.deepEqual(batch.body.data.results.map(item => item.jobId), [jobId]);
    const queryBatch = await ctx.json(`/midi/batchGetResult?jobIds%5B%5D=${jobId}&jobIds%5B%5D=missing`);
    assert.deepEqual(queryBatch.body.data.results.map(item => item.jobId), [jobId]);

    const cancelled = await ctx.json("/midi/cancelGenerate", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    assert.equal(cancelled.body.data.state, "cancelled");
    const firstDelete = await ctx.json("/midi/deleteJob", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    const secondDelete = await ctx.json("/midi/deleteJob", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    assert.equal(firstDelete.body.data.deleted, true);
    assert.equal(secondDelete.body.data.deleted, false);
  } finally {
    await ctx.close();
  }
});

test("local MIDI API exposes one My Upload collection and retires share codes", async () => {
  const ctx = await apiFixture();
  try {
    const videoPath = join(ctx.service.midiStore.root, "outputs", "local.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(videoPath, Buffer.from("0123456789abcdef", "ascii"));
    const song = ctx.service.midiStore.upsertUserSong({
      name: "本地曲目",
      sourceKind: "import",
      videoPath,
      videoByTodView: { default: videoPath },
      contentHash: "1".repeat(64),
      durationUs: 2_000_000,
      performanceType: "PlaySing",
    });
    ctx.service.midiStore.upsertUserSong({
      name: "另一首曲目",
      sourceKind: "import",
      videoPath,
      durationUs: 2_000_000,
    });
    ctx.service.midiStore.upsertUserSong({
      name: "旧琴键视频",
      sourceKind: "upload",
      videoPath,
      durationUs: 2_000_000,
    });
    const listed = await ctx.json("/toy/searchUserSongs?pageSize=20&cursor=0");
    assert.equal(listed.body.code, 0);
    assert.equal(listed.body.data.total, 2);
    const searched = await ctx.json("/toy/searchUserSongs?pageSize=20&cursor=0&query=%E6%9C%AC%E5%9C%B0");
    assert.deepEqual(searched.body.data.list.map(item => item.userSongId), [song.id]);
    assert.equal(searched.body.data.total, 1);
    assert.equal(searched.body.data.list[0].eventId, song.id);
    assert.equal(searched.body.data.list[0].name, "本地曲目");
    assert.match(searched.body.data.list[0].nameKey, /^[A-Za-z0-9_-]+$/u);
    assert.doesNotMatch(searched.body.data.list[0].nameKey, /本地曲目/u);
    assert.equal(searched.body.data.list[0].performanceType, "PlaySing");
    assert.equal(searched.body.data.list[0].performanceTypeDisplayShortName, "弹唱");
    assert.match(searched.body.data.list[0].videoUrl, new RegExp(`/toy/midi/songs/${song.id}/video\\.mp4$`, "u"));
    assert.deepEqual(
      searched.body.data.list[0].videoByTodView.map(item => [item.tod, item.view, item.url]),
      [
        ["TOD12", "NI", searched.body.data.list[0].videoUrl],
        ["TOD12", "WI", searched.body.data.list[0].videoUrl],
        ["TOD1730", "NI", searched.body.data.list[0].videoUrl],
        ["TOD1730", "WI", searched.body.data.list[0].videoUrl],
        ["TOD20", "NI", searched.body.data.list[0].videoUrl],
        ["TOD20", "WI", searched.body.data.list[0].videoUrl],
      ],
    );
    assert.deepEqual(
      searched.body.data.list[0].videoByTodView.map(item => item.duration),
      [2, 2, 2, 2, 2, 2],
    );
    const ranged = await fetch(searched.body.data.list[0].videoUrl, { headers: { Range: "bytes=4-7" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 4-7/16");
    assert.equal(await ranged.text(), "4567");
    const legacyRange = await fetch(`${ctx.base}/toy/midi/songs/${song.id}/video`, {
      headers: { Range: "bytes=8-11" },
    });
    assert.equal(legacyRange.status, 206);
    assert.equal(await legacyRange.text(), "89ab");

    const removed = await ctx.json("/toy/deleteUserSong", {
      method: "POST",
      body: JSON.stringify({ userSongId: song.id }),
    });
    assert.equal(removed.body.data.deleted, true);
    assert.equal((await ctx.json("/toy/searchUserSongs?query=%E6%9C%AC%E5%9C%B0")).body.data.total, 0);

    const retired = await ctx.json("/toy/midi/importShareCode", {
      method: "POST",
      body: JSON.stringify({ shareCode: "123456" }),
    });
    assert.notEqual(retired.body.code, 0);
    assert.match(retired.body.message, /已移除/u);
  } finally {
    await ctx.close();
  }
});

test("My Upload preserves distinct official time-of-day video variants", async () => {
  const ctx = await apiFixture();
  try {
    const firstPath = join(ctx.service.midiStore.root, "outputs", "day.mp4");
    const secondPath = join(ctx.service.midiStore.root, "outputs", "night.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(firstPath, "DAY-VIDEO");
    await writeFile(secondPath, "NIGHT-VIDEO");
    const song = ctx.service.midiStore.upsertUserSong({
      name: "多时段作品",
      sourceKind: "official-import",
      videoPath: firstPath,
      videoByTodView: { TOD1200_NI_L: firstPath, TOD2000_WI_R: secondPath },
      durationUs: 10_000_000,
      contentHash: "e".repeat(64),
    });

    const listed = await ctx.json("/toy/searchUserSongs?query=%E5%A4%9A%E6%97%B6%E6%AE%B5");
    const variants = listed.body.data.list[0].videoByTodView;
    assert.deepEqual(variants.map(item => [item.tod, item.view]), [["TOD12", "NI"], ["TOD12", "WI"], ["TOD1730", "NI"], ["TOD1730", "WI"], ["TOD20", "NI"], ["TOD20", "WI"]]);
    assert.notEqual(variants[0].url, variants[5].url);
    assert.equal(await fetch(variants[0].url).then(response => response.text()), "DAY-VIDEO");
    assert.equal(await fetch(variants[2].url).then(response => response.text()), "DAY-VIDEO");
    assert.equal(await fetch(variants[4].url).then(response => response.text()), "NIGHT-VIDEO");
    assert.equal(await fetch(variants[5].url).then(response => response.text()), "NIGHT-VIDEO");
    assert.equal(listed.body.data.list[0].id, song.id);
  } finally {
    await ctx.close();
  }
});

test("My Upload keeps generic variants unconfirmed and safely uses original default", async () => {
  const ctx = await apiFixture();
  try {
    const outputRoot = join(ctx.service.midiStore.root, "outputs", "generic-variants");
    await mkdir(outputRoot, { recursive: true });
    const dayPath = join(outputRoot, "day.mp4");
    const sunsetPath = join(outputRoot, "sunset.mp4");
    const nightPath = join(outputRoot, "night.mp4");
    await writeFile(dayPath, "DAY");
    await writeFile(sunsetPath, "SUNSET");
    await writeFile(nightPath, "NIGHT");
    const song = ctx.service.midiStore.upsertUserSong({
      name: "起风了",
      sourceKind: "official-import",
      videoPath: dayPath,
      videoByTodView: { DEFAULT: dayPath, ALT_2: sunsetPath, ALT_3: nightPath },
      durationUs: 310_000_000,
      contentHash: "9".repeat(64),
    });

    const item = (await ctx.json("/toy/searchUserSongs?query=%E8%B5%B7%E9%A3%8E%E4%BA%86")).body.data.list[0];
    assert.deepEqual(item.videoByTodView.map(({ tod, view }) => [tod, view]), [
      ["TOD12", "NI"], ["TOD12", "WI"],
      ["TOD1730", "NI"], ["TOD1730", "WI"],
      ["TOD20", "NI"], ["TOD20", "WI"],
    ]);
    assert.equal(item.mappingStatus, "unconfirmed");
    assert.equal(new Set(item.videoByTodView.map(variant => variant.url)).size, 1);
    assert.equal(await fetch(item.videoByTodView[0].url).then(response => response.text()), "DAY");
    assert.equal(await fetch(item.videoByTodView[2].url).then(response => response.text()), "DAY");
    assert.equal(await fetch(item.videoByTodView[4].url).then(response => response.text()), "DAY");
    assert.equal(item.id, song.id);
  } finally {
    await ctx.close();
  }
});

test("playlist rehydrates local My Upload media when the client only sends an item id", async () => {
  const ctx = await apiFixture();
  try {
    const videoPath = join(ctx.service.midiStore.root, "outputs", "playlist-local.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(videoPath, "PLAYLIST-LOCAL");
    const song = ctx.service.midiStore.upsertUserSong({
      name: "本地播单作品",
      sourceKind: "official-import",
      videoPath,
      videoByTodView: { DEFAULT: videoPath },
      durationUs: 70_000_000,
      contentHash: "8".repeat(64),
    });

    const added = await ctx.json("/toy/addToPlaylist", {
      method: "POST",
      body: JSON.stringify({ itemType: 2, itemId: song.id, name: song.name }),
    });
    assert.match(added.body.data.videoUrl, new RegExp(`/toy/midi/songs/${song.id}/video\\.mp4$`, "u"));
    assert.equal(added.body.data.duration, 70);
    assert.equal(added.body.data.performanceType, "Solo");

    const listed = await ctx.json("/toy/searchPlaylist");
    assert.equal(listed.body.data.list[0].videoUrl, added.body.data.videoUrl);
    assert.equal(listed.body.data.list[0].videoByTodView.length, 6);
  } finally {
    await ctx.close();
  }
});

test("My Upload exposes integer variant durations required by the native player", async () => {
  const ctx = await apiFixture();
  try {
    const videoPath = join(ctx.service.midiStore.root, "outputs", "fractional-duration.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(videoPath, "FRACTIONAL-DURATION-VIDEO");
    ctx.service.midiStore.upsertUserSong({
      name: "小数时长作品",
      sourceKind: "official-import",
      videoPath,
      durationUs: 2_500_000,
      contentHash: "f".repeat(64),
    });

    const listed = await ctx.json("/toy/searchUserSongs?query=%E5%B0%8F%E6%95%B0%E6%97%B6%E9%95%BF");
    const variants = listed.body.data.list[0].videoByTodView;
    assert.deepEqual(variants.map(item => item.duration), [3, 3, 3, 3, 3, 3]);
    assert.ok(variants.every(item => Number.isInteger(item.duration)));
  } finally {
    await ctx.close();
  }
});

test("My Upload direct HTTP listing does not materialize or copy native playback files", async () => {
  const nativePlaybackRoot = join(tmpdir(), `olivia-native-playback-${Date.now()}`);
  const ctx = await apiFixture({ nativePlaybackRoot });
  try {
    const videoPath = join(ctx.service.midiStore.root, "outputs", "official-performance.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(videoPath, "OFFICIAL-PERFORMANCE-VIDEO");
    const song = ctx.service.midiStore.upsertUserSong({
      name: "可播放官方作品",
      sourceKind: "official-import",
      videoPath,
      durationUs: 5_000_000,
      contentHash: "c".repeat(64),
    });

    const listed = await ctx.json("/toy/searchUserSongs?query=%E5%8F%AF%E6%92%AD%E6%94%BE");
    const item = listed.body.data.list[0];
    assert.match(item.videoUrl, new RegExp(`/toy/midi/songs/${song.id}/video\\.mp4$`, "u"));
    await assert.rejects(readFile(join(nativePlaybackRoot, item.nameKey, "video.mp4")), { code: "ENOENT" });
    assert.equal(item.nativePlaybackReady, false);
    assert.ok(item.videoByTodView.every(variant => variant.url === item.videoUrl));
  } finally {
    await ctx.close();
    await rm(nativePlaybackRoot, { recursive: true, force: true });
  }
});

test("local webplayer command channel publishes a selected My Upload HTTP video", async () => {
  const ctx = await apiFixture();
  try {
    const videoPath = join(ctx.service.midiStore.root, "outputs", "direct-http.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(videoPath, "DIRECT-HTTP-VIDEO");
    ctx.service.midiStore.upsertUserSong({
      name: "直连播放作品",
      sourceKind: "official-import",
      videoPath,
      durationUs: 4_000_000,
      contentHash: "d".repeat(64),
    });
    const item = (await ctx.json("/toy/searchUserSongs?query=%E7%9B%B4%E8%BF%9E")).body.data.list[0];
    const published = await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: item.videoUrl, songId: item.id, name: item.name }),
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.data.command.cmd, "play");
    assert.equal(new URL(published.body.data.command.url).pathname, new URL(item.videoUrl).pathname);
    assert.match(new URL(published.body.data.command.url).searchParams.get("playSession") ?? "", /^[0-9a-f-]{36}$/u);
    assert.equal(published.body.data.command.songId, item.id);
    assert.equal(published.body.data.command.name, item.name);
    assert.ok(published.body.data.revision > 0);
    const current = await ctx.json("/toy/player-command");
    assert.deepEqual(current.body.data, published.body.data);
    const progress = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: published.body.data.revision,
        sessionId: published.body.data.command.sessionId,
        songId: item.id,
        mediaUrl: published.body.data.command.url,
        event: "timeupdate",
        currentTime: 2.5,
        duration: 4,
      }),
    });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.data.commandRevision, published.body.data.revision);
    assert.equal(progress.body.data.currentTime, 2.5);
    assert.equal(progress.body.data.duration, 4);
    assert.equal(progress.body.data.event, "timeupdate");
    assert.deepEqual((await ctx.json("/toy/player-state")).body.data, progress.body.data);
    const seek = await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({
        cmd: "seek",
        offset: 3,
        songId: item.id,
        sessionId: published.body.data.command.sessionId,
      }),
    });
    assert.equal(seek.status, 200);
    assert.equal(seek.body.data.command.cmd, "seek");
    assert.equal(seek.body.data.command.offset, 3);
    assert.equal(seek.body.data.command.songId, item.id);
    assert.ok(seek.body.data.revision > published.body.data.revision);
    const afterSeek = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: seek.body.data.revision,
        sessionId: seek.body.data.command.sessionId,
        event: "timeupdate",
        currentTime: 3.25,
        duration: 4,
        songId: item.id,
        mediaUrl: published.body.data.command.url,
      }),
    });
    assert.equal(afterSeek.body.data.songId, item.id);
    assert.equal(afterSeek.body.data.currentTime, 3.25);
    assert.equal(await fetch(item.videoUrl).then(response => response.text()), "DIRECT-HTTP-VIDEO");
  } finally {
    await ctx.close();
  }
});

test("local webplayer binds progress and controls to one playback session", async () => {
  const ctx = await apiFixture();
  try {
    const outputRoot = join(ctx.service.midiStore.root, "outputs");
    await mkdir(outputRoot, { recursive: true });
    const firstPath = join(outputRoot, "first.mp4");
    const secondPath = join(outputRoot, "second.mp4");
    await writeFile(firstPath, "FIRST-VIDEO");
    await writeFile(secondPath, "SECOND-VIDEO");
    ctx.service.midiStore.upsertUserSong({
      name: "第一首",
      sourceKind: "official-import",
      videoPath: firstPath,
      durationUs: 10_000_000,
      contentHash: "a".repeat(64),
    });
    ctx.service.midiStore.upsertUserSong({
      name: "第二首",
      sourceKind: "official-import",
      videoPath: secondPath,
      durationUs: 20_000_000,
      contentHash: "b".repeat(64),
    });
    const songs = (await ctx.json("/toy/searchUserSongs?pageSize=10")).body.data.list;
    const first = songs.find(song => song.name === "第一首");
    const second = songs.find(song => song.name === "第二首");

    const firstPlay = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: first.videoUrl, songId: first.id, name: first.name }),
    })).body.data;
    assert.match(firstPlay.command.sessionId, /^[0-9a-f-]{36}$/u);

    const secondPlay = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: second.videoUrl, songId: second.id, name: second.name }),
    })).body.data;
    assert.notEqual(secondPlay.command.sessionId, firstPlay.command.sessionId);
    assert.deepEqual(
      {
        songId: secondPlay.command.songId,
        currentTime: (await ctx.json("/toy/player-state")).body.data.currentTime,
        playbackState: (await ctx.json("/toy/player-state")).body.data.playbackState,
      },
      { songId: second.id, currentTime: 0, playbackState: "playing" },
    );

    const staleFirst = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: firstPlay.revision,
        sessionId: firstPlay.command.sessionId,
        songId: first.id,
        mediaUrl: firstPlay.command.url,
        event: "timeupdate",
        currentTime: 7,
        duration: 10,
      }),
    });
    assert.equal(staleFirst.body.data.songId, second.id);
    assert.equal(staleFirst.body.data.currentTime, 0);

    const staleEndedForSameSong = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: firstPlay.revision,
        sessionId: firstPlay.command.sessionId,
        songId: second.id,
        mediaUrl: secondPlay.command.url,
        event: "ended",
        currentTime: 20,
        duration: 20,
      }),
    });
    assert.equal(staleEndedForSameSong.body.data.songId, second.id);
    assert.equal(staleEndedForSameSong.body.data.playbackState, "playing");
    assert.equal(staleEndedForSameSong.body.data.currentTime, 0,
      "stale ended must not terminate the current session even when the song id matches");

    const seek = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({
        cmd: "seek",
        offset: 12,
        songId: second.id,
        sessionId: secondPlay.command.sessionId,
      }),
    })).body.data;
    assert.equal(seek.command.sessionId, secondPlay.command.sessionId);
    assert.equal((await ctx.json("/toy/player-state")).body.data.currentTime, 12);

    const regressive = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: seek.revision,
        sessionId: seek.command.sessionId,
        songId: second.id,
        mediaUrl: secondPlay.command.url,
        event: "timeupdate",
        currentTime: 4,
        duration: 20,
      }),
    });
    assert.equal(regressive.body.data.currentTime, 12, "pre-seek timeupdate must not snap the slider backwards");

    const seekAcknowledged = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: seek.revision,
        sessionId: seek.command.sessionId,
        songId: second.id,
        mediaUrl: secondPlay.command.url,
        event: "timeupdate",
        currentTime: 12.25,
        duration: 20,
      }),
    });
    assert.equal(seekAcknowledged.body.data.currentTime, 12.25);

    const pause = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "pause", songId: second.id, sessionId: secondPlay.command.sessionId }),
    })).body.data;
    assert.equal(pause.command.sessionId, secondPlay.command.sessionId);
    assert.equal(pause.command.cmd, "stop", "pause is a terminal command in the game UI");
    assert.equal(pause.command.restoreDefault, true);
    assert.equal((await ctx.json("/toy/player-state")).body.data.playbackState, "stopped");
    const afterPausedTick = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: pause.revision,
        sessionId: pause.command.sessionId,
        songId: second.id,
        mediaUrl: secondPlay.command.url,
        event: "timeupdate",
        currentTime: 15,
        duration: 20,
      }),
    });
    assert.equal(afterPausedTick.body.data.currentTime, 0, "stopped progress must remain cleared");

    const resume = await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "resume", songId: second.id, sessionId: secondPlay.command.sessionId }),
    });
    assert.equal(resume.status, 200, "toy compatibility routes keep their HTTP envelope");
    assert.equal(resume.body.code, -1, "a terminal pause cannot be resumed");
    assert.match(resume.body.message, /已经结束/u);

    const replayAfterPause = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: second.videoUrl, songId: second.id, name: second.name }),
    })).body.data;
    assert.equal(replayAfterPause.command.loop, false, "local videos must never inherit wallpaper looping");
    const ended = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: replayAfterPause.revision,
        sessionId: replayAfterPause.command.sessionId,
        songId: second.id,
        mediaUrl: replayAfterPause.command.url,
        event: "timeupdate",
        currentTime: 19.7,
        duration: 20,
      }),
    });
    assert.equal(ended.body.data.playbackState, "ended");
    assert.equal(ended.body.data.event, "ended");
    assert.equal(ended.body.data.currentTime, 20);
    const afterEndedTick = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: replayAfterPause.revision,
        sessionId: replayAfterPause.command.sessionId,
        songId: second.id,
        mediaUrl: replayAfterPause.command.url,
        event: "timeupdate",
        currentTime: 19,
        duration: 20,
      }),
    });
    assert.equal(afterEndedTick.body.data.playbackState, "ended");
    assert.equal(afterEndedTick.body.data.currentTime, 20, "ended progress must remain at the duration");

    const release = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({
        cmd: "stop",
        songId: second.id,
        sessionId: replayAfterPause.command.sessionId,
        restoreDefault: false,
      }),
    })).body.data;
    assert.equal(release.command.cmd, "stop");
    assert.equal(release.command.restoreDefault, false,
      "playlist advancement releases the terminal session without restoring wallpaper between songs");
    assert.equal((await ctx.json("/toy/player-command")).body.data.command.cmd, "stop",
      "an ended upload must not leave a replayable play command behind");

    const replay = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: second.videoUrl, songId: second.id, name: second.name }),
    })).body.data;
    const nativeEnded = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: replay.revision,
        sessionId: replay.command.sessionId,
        songId: second.id,
        mediaUrl: replay.command.url,
        event: "ended",
        currentTime: 20,
        duration: 20,
      }),
    });
    assert.equal(nativeEnded.body.data.playbackState, "ended", "native ended remains the primary completion event");
    assert.equal(nativeEnded.body.data.event, "ended");
  } finally {
    await ctx.close();
  }
});

test("stale stop cannot terminate a replayed session of the same song", async () => {
  const ctx = await apiFixture();
  try {
    const outputRoot = join(ctx.service.midiStore.root, "outputs");
    await mkdir(outputRoot, { recursive: true });
    const videoPath = join(outputRoot, "same-song-replay.mp4");
    await writeFile(videoPath, "SAME-SONG-REPLAY");
    ctx.service.midiStore.upsertUserSong({
      name: "同曲重播",
      sourceKind: "official-import",
      videoPath,
      durationUs: 12_000_000,
      contentHash: "c".repeat(64),
    });
    const song = (await ctx.json("/toy/searchUserSongs?query=%E5%90%8C%E6%9B%B2%E9%87%8D%E6%92%AD")).body.data.list[0];
    const first = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: song.videoUrl, songId: song.id, name: song.name }),
    })).body.data;
    const replay = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: song.videoUrl, songId: song.id, name: song.name }),
    })).body.data;
    assert.notEqual(replay.command.sessionId, first.command.sessionId);
    assert.notEqual(replay.command.url, first.command.url,
      "each replay needs a generation-specific media URL even when the song is unchanged");

    const staleEndedTaggedAsCurrent = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: replay.revision,
        sessionId: replay.command.sessionId,
        songId: song.id,
        mediaUrl: first.command.url,
        event: "ended",
        currentTime: 12,
        duration: 12,
      }),
    });
    assert.equal(staleEndedTaggedAsCurrent.body.data.playbackState, "playing");
    assert.equal(staleEndedTaggedAsCurrent.body.data.sessionId, replay.command.sessionId);

    const staleStop = await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({
        cmd: "stop",
        songId: song.id,
        sessionId: first.command.sessionId,
        restoreDefault: false,
      }),
    });
    assert.equal(staleStop.body.code, -1);
    const afterStaleStop = (await ctx.json("/toy/player-state")).body.data;
    assert.equal(afterStaleStop.playbackState, "playing");
    assert.equal(afterStaleStop.sessionId, replay.command.sessionId);
    assert.equal((await ctx.json("/toy/player-command")).body.data.command.sessionId, replay.command.sessionId);

    const validStop = await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({
        cmd: "stop",
        songId: song.id,
        sessionId: replay.command.sessionId,
        restoreDefault: true,
      }),
    });
    assert.equal(validStop.body.code, 0);
    assert.equal(validStop.body.data.command.cmd, "stop");
    assert.equal((await ctx.json("/toy/player-state")).body.data.playbackState, "stopped");
  } finally {
    await ctx.close();
  }
});

test("temporary two-second metadata cannot end a longer imported video", async () => {
  const ctx = await apiFixture();
  try {
    const outputRoot = join(ctx.service.midiStore.root, "outputs");
    await mkdir(outputRoot, { recursive: true });
    const videoPath = join(outputRoot, "long-imported-video.mp4");
    await writeFile(videoPath, "LONG-IMPORTED-VIDEO");
    ctx.service.midiStore.upsertUserSong({
      name: "长视频切换",
      sourceKind: "official-import",
      videoPath,
      durationUs: 84_866_667,
      contentHash: "e".repeat(64),
    });
    const song = (await ctx.json("/toy/searchUserSongs?query=%E9%95%BF%E8%A7%86%E9%A2%91%E5%88%87%E6%8D%A2")).body.data.list[0];
    const play = (await ctx.json("/toy/player-command", {
      method: "POST",
      body: JSON.stringify({ cmd: "play", url: song.videoUrl, songId: song.id, name: song.name }),
    })).body.data;

    const transitionalTick = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: play.revision,
        sessionId: play.command.sessionId,
        songId: song.id,
        mediaUrl: play.command.url,
        event: "timeupdate",
        currentTime: 1.8,
        duration: 2,
      }),
    });
    assert.equal(transitionalTick.body.data.playbackState, "playing");
    assert.equal(transitionalTick.body.data.currentTime, 1.8);
    assert.equal(transitionalTick.body.data.duration, 84.866667);

    const transitionalEnded = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: play.revision,
        sessionId: play.command.sessionId,
        songId: song.id,
        mediaUrl: play.command.url,
        event: "ended",
        currentTime: 2,
        duration: 2,
      }),
    });
    assert.equal(transitionalEnded.body.data.playbackState, "playing");
    assert.equal(transitionalEnded.body.data.currentTime, 1.8);
    assert.equal(transitionalEnded.body.data.duration, 84.866667);

    const nativeEnded = await ctx.json("/toy/player-state", {
      method: "POST",
      body: JSON.stringify({
        commandRevision: play.revision,
        sessionId: play.command.sessionId,
        songId: song.id,
        mediaUrl: play.command.url,
        event: "ended",
        currentTime: 84.866667,
        duration: 84.866667,
      }),
    });
    assert.equal(nativeEnded.body.data.playbackState, "ended");
    assert.equal(nativeEnded.body.data.currentTime, 84.866667);
  } finally {
    await ctx.close();
  }
});

test("My Upload revision invalidates cached rows from older native media schemas", async () => {
  const ctx = await apiFixture();
  try {
    const listed = await ctx.json("/toy/searchUserSongs?pageSize=1");
    assert.ok(listed.body.data.revision >= 2_200_000_000);
  } finally {
    await ctx.close();
  }
});

test("local MIDI API keeps legacy job diagnostics while all new upload tokens are disabled", async () => {
  const ctx = await apiFixture();
  try {
    const wrong = await ctx.json("/toy/genObjectUploadUrl", {
      method: "POST",
      body: JSON.stringify({ filename: "not-midi.txt" }),
    });
    assert.equal(wrong.body.code, "MIDI_RENDERING_DISABLED");
    assert.equal(ctx.service.midiStore.listJobs().length, 0);
    const directUpload = await ctx.json("/toy/midi/upload/legacy-token", {
      method: "PUT",
      body: Buffer.from("MThd"),
      headers: { "Content-Type": "application/octet-stream" },
    });
    assert.equal(directUpload.body.code, "MIDI_RENDERING_DISABLED");
  } finally {
    await ctx.close();
  }
});

test("My Upload uses stable cursor pagination and revision without a fixed total", async () => {
  const ctx = await apiFixture();
  try {
    const videoPath = join(ctx.service.midiStore.root, "outputs", "shared.mp4");
    await mkdir(join(ctx.service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(videoPath, "video");
    for (let index = 0; index < 205; index += 1) {
      ctx.service.midiStore.upsertUserSong({
        name: `作品 ${String(index).padStart(3, "0")}`,
        sourceKind: "official-import",
        videoPath,
        durationUs: 1_000_000,
        contentHash: index.toString(16).padStart(64, "0"),
      });
    }

    const first = await ctx.json("/toy/searchUserSongs?pageSize=100");
    assert.equal(first.body.data.list.length, 100);
    assert.equal(first.body.data.total, 205);
    assert.equal(first.body.data.hasMore, true);
    assert.equal(typeof first.body.data.nextCursor, "string");
    assert.ok(Number.isInteger(first.body.data.revision));

    const second = await ctx.json(`/toy/searchUserSongs?pageSize=100&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
    const third = await ctx.json(`/toy/searchUserSongs?pageSize=100&cursor=${encodeURIComponent(second.body.data.nextCursor)}`);
    const ids = [...first.body.data.list, ...second.body.data.list, ...third.body.data.list].map(item => item.id);
    assert.equal(new Set(ids).size, 205);
    assert.equal(third.body.data.hasMore, false);
    assert.equal(third.body.data.nextCursor, null);

    ctx.service.midiStore.upsertUserSong({
      name: "新增作品",
      sourceKind: "official-import",
      videoPath,
      durationUs: 1_000_000,
      contentHash: "f".repeat(64),
    });
    const changed = await ctx.json("/toy/searchUserSongs?pageSize=100");
    assert.ok(changed.body.data.revision > first.body.data.revision);
  } finally {
    await ctx.close();
  }
});

test("admin MIDI library API previews and confirms a local folder import", async () => {
  const probed = [];
  const watches = [];
  const ctx = await apiFixture({
    midiDurationProbe: async path => {
      probed.push(path);
      return 31_250_000;
    },
    midiLibrarySyncIntervalMs: 60_000,
    midiLibraryWatchFactory: options => {
      watches.push(options);
      return { close() {} };
    },
  });
  try {
    const library = join(ctx.root, "downloaded-library");
    const song = join(library, "Imported Song");
    await mkdir(song, { recursive: true });
    await writeFile(join(song, "take_TOD1730_NI_L.mp4"), "video");

    const preview = await ctx.json("/admin/api/midi-library/preview", {
      method: "POST",
      body: JSON.stringify({ root: library, mode: "reference" }),
    });
    assert.equal(preview.body.code, 0);
    assert.equal(preview.body.data.total, 1);
    assert.equal(preview.body.data.entries[0].name, "Imported Song");
    assert.equal(preview.body.data.mode, "reference");

    const confirmed = await ctx.json("/admin/api/midi-library/confirm", {
      method: "POST",
      body: JSON.stringify({ previewId: preview.body.data.previewId }),
    });
    assert.equal(confirmed.body.data.imported, 1);
    assert.equal(probed.length, 1);
    assert.equal(watches.length, 1);
    assert.equal(watches[0].root, library);

    const status = await ctx.json("/admin/api/midi");
    assert.equal(status.body.data.dataRoot, library);
    assert.equal(status.body.data.songs.length, 1);
    assert.equal(status.body.data.songs[0].durationUs, 31_250_000);
    assert.match(ctx.service.midiStore.resolvePath(status.body.data.songs[0].videoPath), /downloaded-library/u);
    assert.equal(status.body.data.library.mode, "reference");

    const downloaded = join(library, "midi_new_share_1");
    await mkdir(downloaded, { recursive: true });
    await writeFile(join(downloaded, "downloaded.mp4"), "new-video");
    await watches[0].onChange();
    assert.equal(ctx.service.midiStore.listUserSongs().length, 2);
    assert.ok(ctx.service.midiStore.listUserSongs().some(item => item.name === "个人上传 · midi_new_share_1"));
  } finally {
    await ctx.close();
  }
});

test("admin duration repair API backfills existing zero-duration videos", async () => {
  const ctx = await apiFixture({ midiDurationProbe: async () => 44_500_000 });
  try {
    const song = ctx.service.midiStore.upsertUserSong({
      name: "旧视频",
      sourceKind: "import",
      videoPath: join(ctx.service.midiStore.root, "outputs", "old.mp4"),
      durationUs: 0,
      contentHash: "9".repeat(64),
    });

    const started = await ctx.json("/admin/api/midi-duration-repair/start", { method: "POST" });
    assert.equal(started.body.code, 0);
    assert.equal(started.body.data.state, "complete");
    assert.equal(started.body.data.completed, 1);

    const status = await ctx.json("/admin/api/midi-duration-repair");
    assert.equal(status.body.data.state, "complete");
    assert.equal(ctx.service.midiStore.getUserSong(song.id).durationUs, 44_500_000);
  } finally {
    await ctx.close();
  }
});
