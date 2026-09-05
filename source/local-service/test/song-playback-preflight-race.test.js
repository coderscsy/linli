import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createOliviaService } from "../server.js";
import { blockedFetchPorts } from "./fixtures/fetch-ports.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Hold only one real media stat, keeping source resolution, the HTTP routes,
// SQLite, and every other filesystem operation real. Node isolates test files
// in separate processes; the tests in this file must remain sequential.
function holdNextStat(file) {
  const entered = deferred(), released = deferred();
  const original = fs.stat;
  let held = false;
  fs.stat = async (path, ...args) => {
    if (!held && typeof path === "string" && resolve(path) === resolve(file)) {
      held = true;
      entered.resolve();
      await released.promise;
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  return {
    async entered() {
      let timeout;
      try {
        await Promise.race([
          entered.promise,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("play did not reach the selected media stat")), 3000);
          }),
        ]);
      } finally { clearTimeout(timeout); }
    },
    release: released.resolve,
    restore() {
      released.resolve();
      fs.stat = original;
      syncBuiltinESMExports();
    },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "olivia-playback-preflight-"));
  const service = await createOliviaService({
    root, dataDir: join(root, "data"), officialMediaRoot: join(root, "media"),
    appData: join(root, "app-data"), runtimeDir: join(root, "runtime"),
    worker: false, runMemoryRefresh: false,
    playbackNow: () => new Date(2026, 8, 4, 12),
    midiDurationProbe: async () => 120_000_000,
    fetch: async () => { throw new Error("External requests are disabled in this test"); },
  });
  let address = await service.listen(0);
  while (blockedFetchPorts.has(address.port)) {
    await new Promise(resolvePromise => service.server.close(resolvePromise));
    address = await service.listen(0);
  }
  const base = `http://127.0.0.1:${address.port}`;
  const json = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  };
  await fs.mkdir(join(service.midiStore.root, "outputs"), { recursive: true });
  const songs = {}, files = {};
  for (const [key, contents] of [["a", "FIRST CLIP"], ["b", "SECOND CLIP"], ["replacement", "REBOUND CLIP"]]) {
    files[key] = join(service.midiStore.root, "outputs", `${key}.mp4`);
    await fs.writeFile(files[key], contents);
    if (key === "replacement") continue;
    songs[key] = service.midiStore.upsertUserSong({
      id: `preflight-${key}`, name: `Work ${key}`, sourceKind: "official-import",
      videoPath: files[key], videoByTodView: { DEFAULT: files[key] },
      durationUs: 120_000_000, contentHash: key.repeat(64),
    });
  }
  return {
    service, json, songs, files,
    play: song => json("/toy/player-command", {
      cmd: "play", songId: song.id, url: `${base}/toy/midi/songs/${song.id}/video.mp4`,
    }),
    close: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

test("a slow play preflight cannot publish early or replace a newer successful play", { concurrency: false, timeout: 60000 }, async () => {
  const ctx = await fixture();
  const gate = holdNextStat(ctx.files.a);
  let pending;
  try {
    const before = (await ctx.json("/toy/player-command")).data;
    pending = ctx.play(ctx.songs.a);
    await gate.entered();
    assert.deepEqual((await ctx.json("/toy/player-command")).data, before,
      "an unvalidated source must not become the desktop command");
    const newer = await ctx.play(ctx.songs.b);
    assert.equal(newer.status, 200);
    assert.equal(newer.data.command.songId, ctx.songs.b.id);
    gate.release();
    assert.notEqual((await pending).code, 0);
    assert.deepEqual((await ctx.json("/toy/player-command")).data, newer.data);
    const state = (await ctx.json("/toy/player-state")).data;
    assert.equal(state.songId, ctx.songs.b.id);
    assert.equal(state.sessionId, newer.data.command.sessionId);
    assert.equal(state.mediaUrl, newer.data.command.url);
    assert.equal(state.playbackState, "playing");
  } finally {
    gate.restore();
    await pending?.catch(() => {});
    await ctx.close();
  }
});

test("stopping the active work invalidates an older pending play preflight", { concurrency: false, timeout: 60000 }, async () => {
  const ctx = await fixture();
  let gate, pending;
  try {
    const active = await ctx.play(ctx.songs.b);
    assert.equal(active.status, 200);
    gate = holdNextStat(ctx.files.a);
    pending = ctx.play(ctx.songs.a);
    await gate.entered();
    assert.deepEqual((await ctx.json("/toy/player-command")).data, active.data);
    const stopped = await ctx.json("/toy/player-command", {
      cmd: "stop", songId: ctx.songs.b.id, sessionId: active.data.command.sessionId,
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.command.cmd, "stop");
    gate.release();
    assert.notEqual((await pending).code, 0);
    assert.deepEqual((await ctx.json("/toy/player-command")).data, stopped.data);
    const state = (await ctx.json("/toy/player-state")).data;
    assert.equal(state.songId, ctx.songs.b.id);
    assert.equal(state.sessionId, active.data.command.sessionId);
    assert.equal(state.playbackState, "stopped");
    assert.equal(state.currentTime, 0);
  } finally {
    gate?.restore();
    await pending?.catch(() => {});
    await ctx.close();
  }
});

test("deletion or same-ID source rebinding during preflight cannot publish a stale play", { concurrency: false, timeout: 120000 }, async () => {
  for (const mutation of ["delete", "rebind"]) {
    const ctx = await fixture();
    const gate = holdNextStat(ctx.files.a);
    let pending;
    try {
      const beforeCommand = (await ctx.json("/toy/player-command")).data;
      const beforeState = (await ctx.json("/toy/player-state")).data;
      pending = ctx.play(ctx.songs.a);
      await gate.entered();
      ctx.service.midiStore.deleteUserSong(ctx.songs.a.id);
      if (mutation === "rebind") {
        ctx.service.midiStore.upsertUserSong({
          id: ctx.songs.a.id, name: "Replacement work", sourceKind: "official-import",
          contentHash: "c".repeat(64), durationUs: 120_000_000,
          videoPath: ctx.files.replacement, videoByTodView: { DEFAULT: ctx.files.replacement },
        });
      }
      gate.release();
      const rejected = await pending;
      assert.notEqual(rejected.code, 0, `${mutation} must reject the obsolete play`);
      assert.deepEqual((await ctx.json("/toy/player-command")).data, beforeCommand, mutation);
      assert.deepEqual((await ctx.json("/toy/player-state")).data, beforeState, mutation);
    } finally {
      gate.restore();
      await pending?.catch(() => {});
      await ctx.close();
    }
  }
});
