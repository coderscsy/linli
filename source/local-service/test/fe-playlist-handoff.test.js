import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const patch = await readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8");
const replacement = name => patch.match(new RegExp(`^\\$${name} = '([^\\r\\n]*)'\\r?$`, "mu"))[1]
  .replaceAll("' + $playerCommandUrl + '", "http://test/command")
  .replaceAll("' + $playerStateUrl + '", "http://test/state");
const store = replacement("playerStateStoreTo");
const finish = store.match(/OliviaSoulFinishLocalPlayback=(async B=>\{[\s\S]*?\}),OliviaSoulApplyPlayerState=/u)[1];
const apply = store.match(/OliviaSoulApplyPlayerState=(B=>\{[\s\S]*?\}),OliviaSoulEnsurePlayerPoll=/u)[1];

function fixture({ mode = "list", source = "playlist" } = {}) {
  const window = { __OliviaSoulSessionEpoch: 1, __OliviaSoulSongId: "upload", __OliviaSoulSessionId: "session" };
  const d = { value: 244 }, m = { value: true };
  const native = [], advances = [], requests = [], endReasons = [], microtasks = [];
  const context = vm.createContext({
    window, d, m, h: { value: source }, p: { value: mode }, ot: { Single: "single" },
    u: { value: { itemId: "upload" } }, f: { value: null },
    a: () => true,
    M() { advances.push({ kind: "repeat", position: d.value }); m.value = true; },
    U() { advances.push({ kind: "next", position: d.value }); m.value = true; },
    G() { d.value = 0; m.value = false; },
    w(reason) { endReasons.push(reason); },
    queueMicrotask(fn) { microtasks.push(fn); },
    We: async ({ data }) => { native.push(data); },
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) }; },
  });
  vm.runInContext(replacement("directControlTo"), context);
  context.OliviaSoulFinishLocalPlayback = vm.runInContext(`(${finish})`, context);
  context.apply = vm.runInContext(`(${apply})`, context);
  const ended = { songId: "upload", sessionId: "session", playbackState: "ended" };
  return { context, window, d, m, native, advances, requests, endReasons,
    finish: () => context.OliviaSoulFinishLocalPlayback(ended),
    apply: () => context.apply(ended),
    flush() { while (microtasks.length) microtasks.shift()(); },
  };
}

test("local end clears the old 244-second position before advancing to a shorter official song", async () => {
  const player = fixture();
  await player.finish();
  assert.deepEqual(player.advances, [{ kind: "next", position: 0 }]);
  assert.equal(player.requests[0].restoreDefault, false);
  assert.equal(player.m.value, true);
});

test("single repeat also starts at zero, while direct non-playlist playback stops", async () => {
  const single = fixture({ mode: "single" });
  await single.finish();
  assert.deepEqual(single.advances, [{ kind: "repeat", position: 0 }]);
  const direct = fixture({ source: "songlist" });
  await direct.finish();
  assert.deepEqual(direct.advances, []);
  assert.equal(direct.requests[0].restoreDefault, true);
  assert.equal(direct.m.value, false);
});

test("programmatic slider feedback is suppressed even after the local identity is cleared", async () => {
  const player = fixture();
  player.window.__OliviaSoulSongId = null;
  player.window.__OliviaSoulApplyingProgress = true;
  await player.context.Ct({ cmd: "timeupdate", position: 123 });
  assert.deepEqual(player.native, []);
  player.window.__OliviaSoulApplyingProgress = false;
  await player.context.Ct({ cmd: "timeupdate", position: 40 });
  assert.equal(player.native[0].position, 40, "real user seeking remains available");
});

test("duplicate ended snapshots produce one completion and one playlist advance", async () => {
  const player = fixture();
  player.apply();
  player.apply();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(player.endReasons, ["natural_end"]);
  assert.equal(player.requests.length, 1);
  assert.equal(player.advances.length, 1);
});

const ensurePoll = store.match(/OliviaSoulEnsurePlayerPoll=(\(\)=>\{[\s\S]*?\}),OliviaSoulSongIdFromItem=/u)[1];
function pollFixture() {
  let poll, timeout, requestCount = 0, lastSignal;
  const window = { __OliviaSoulSongId: "upload", __OliviaSoulSessionId: "session" };
  const context = vm.createContext({
    window, AbortController,
    setInterval(fn) { poll = fn; return 1; },
    setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {},
    fetch(url, options) {
      requestCount++;
      lastSignal = options.signal;
      return new Promise((resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
  vm.runInContext(`(${ensurePoll})()`, context);
  return { window, tick: () => poll(), expire: () => timeout(), count: () => requestCount, signal: () => lastSignal };
}

test("player status polling does not accumulate requests while the service stalls", async () => {
  const player = pollFixture();
  player.tick();
  for (let i = 0; i < 100; i++) player.tick();
  assert.equal(player.count(), 1);
});

test("no local playback means no local status polling", () => {
  const player = pollFixture();
  player.window.__OliviaSoulSongId = null;
  player.window.__OliviaSoulSessionId = null;
  player.tick();
  assert.equal(player.count(), 0);
});

test("a stalled request is aborted and a later poll can recover", async () => {
  const player = pollFixture();
  const pending = player.tick();
  assert.ok(player.signal(), "poll must have a cancellable timeout");
  player.expire();
  await pending;
  assert.equal(player.signal().aborted, true);
  const next = player.tick();
  assert.equal(player.count(), 2);
  player.expire();
  await next;
});
