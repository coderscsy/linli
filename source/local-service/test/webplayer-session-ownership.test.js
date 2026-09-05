import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const patch = await readFile(new URL("../../tools/patch-webplayer-local.ps1", import.meta.url), "utf8");
const commandUrl = "http://127.0.0.1:27149/toy/player-command";
const stateUrl = "http://127.0.0.1:27149/toy/player-state";
function replacement(name) {
  const line = patch.match(new RegExp(`^\\$${name} = '([^\\r\\n]*)'\\r?$`, "mu"))?.[1];
  assert.ok(line, `missing ${name} production replacement`);
  return line.replaceAll("' + $playerCommandUrl + '", commandUrl)
    .replaceAll("' + $playerStateUrl + '", stateUrl);
}
const nativeControl = (patch.match(/\$nativeControl = @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1] ?? "")
  .replaceAll("__OLIVIA_PLAYER_STATE_URL__", stateUrl);
const wallpaper = "https://olivia.local/assets/Wallpaper_Presence/default.mp4";
const localUrl = "http://127.0.0.1:27149/toy/midi/songs/local-song/video.mp4?playSession=local-session";

// Run the actual mounted subscription, command branches and progress handler.
// The fake media loader models only resource selection, not browser decoding.
function fixture() {
  let nativeHandler;
  let poll;
  let serviceCommand = { revision: 0, command: null };
  let serviceState = {};
  let fetchFailure = false;
  let pendingStateResponse;
  const progress = [];
  const nativeEvents = [];
  const timeouts = new Map();
  let timerId = 0;
  const video = {
    src: wallpaper, currentSrc: wallpaper, currentTime: 0, duration: 360.566667,
    loop: true, paused: false, style: {},
    pause() { this.paused = true; },
    play() { this.paused = false; },
    removeAttribute(name) { if (name === "src") this.src = ""; },
    load() { this.currentSrc = this.src; this.currentTime = 0; },
  };
  const state = {};
  const context = vm.createContext({
    window: state, console: { log() {}, info() {}, warn() {} }, AbortController,
    sessionStorage: { getItem: () => null, setItem() {} },
    i: { value: video }, l: { value: [video] }, a: { value: video.duration },
    f: null, y: null,
    ke(fn) { fn(); }, qe(fn) { nativeHandler = fn; return () => {}; }, Je() { return () => {}; }, me() {}, R() {},
    setInterval(fn) { poll = fn; return 1; }, clearInterval() {},
    setTimeout(fn) { const id = ++timerId; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); },
    async fetch(url, options) {
      if (fetchFailure) throw new Error("service offline");
      if (options?.method === "POST") {
        const body = JSON.parse(options.body);
        progress.push(body);
        return { ok: true, json: async () => ({ code: 0, data: {} }) };
      }
      if (url === stateUrl && pendingStateResponse) return pendingStateResponse;
      return { ok: true, json: async () => ({ code: 0, data: url === commandUrl ? serviceCommand : serviceState }) };
    },
    le(url, options) {
      video.src = video.currentSrc = url;
      video.currentTime = options.offset ?? 0;
      video.loop = options.loop;
      video.play();
    },
    fe() { video.pause(); }, ae() {}, ce() { video.play(); }, K(offset) { video.currentTime = offset; },
    Z(event) { nativeEvents.push(event); }, de() {}, ye() {}, ve(loop) { video.loop = loop; },
  });
  vm.runInContext(`${nativeControl}
    function pe(e){if(!e?.cmd)return;switch(e.cmd){${replacement("playTo")}${replacement("stopTo")}${replacement("preloadTo")}
      case "seek":K(e.offset);break;case "resume":ce();break;case "setLoop":ve(e.loop);break;}}
    ${replacement("timeUpdateTo")}
    ${replacement("mountedTo")}`, context);
  return {
    video, state, progress, nativeEvents,
    native(command) { return nativeHandler(command); },
    direct(command) { context.pe(command); },
    async start() {
      await poll();
      serviceCommand = { revision: 1, command: { cmd: "play", url: localUrl, songId: "local-song", sessionId: "local-session" } };
      serviceState = { revision: 1, commandRevision: 1, sessionId: "local-session", songId: "local-song", name: "Example song",
        playbackState: "playing", event: "play", currentTime: 0, duration: 360.566667, mediaUrl: localUrl };
      await poll();
      assert.equal(state.__OliviaSoulActiveSessionId, "local-session", "fixture must start real local playback before injecting late commands");
      assert.equal(video.currentSrc, localUrl);
    },
    async command(command, revision = 2) { serviceCommand = { revision, command }; await poll(); },
    setState(next) { serviceState = next; },
    offline() { fetchFailure = true; },
    holdState() {
      let resolve;
      pendingStateResponse = new Promise(done => { resolve = done; });
      return data => resolve({ ok: true, json: async () => ({ code: 0, data }) });
    },
    async advance(seconds) {
      if (!video.paused) video.currentTime += seconds;
      await context.z({ target: video });
    },
  };
}

for (const command of [{ cmd: "pause" }, { cmd: "stop" }, { cmd: "play", url: wallpaper, loop: true }]) {
  test(`late native ${command.cmd}${command.url ? " wallpaper" : ""} cannot replace a playing local session`, async () => {
    const player = fixture();
    await player.start();
    await player.advance(2.612582);
    await player.native(command);
    await player.advance(5);
    assert.equal(player.video.currentSrc, localUrl);
    assert.equal(player.video.paused, false);
    assert.equal(player.state.__OliviaSoulActiveSessionId, "local-session");
    assert.equal(player.progress.at(-1).sessionId, "local-session");
    assert.equal(player.progress.at(-1).currentTime, 7.612582);
  });
}

test("current-session service stop still returns to the most recently remembered wallpaper", async () => {
  const player = fixture();
  await player.start();
  const nextWallpaper = "https://olivia.local/assets/Wallpaper_Presence/evening.mp4";
  await player.native({ cmd: "play", url: nextWallpaper, offset: 8, loop: true });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session", restoreDefault: true });
  assert.equal(player.video.currentSrc, nextWallpaper);
  assert.equal(player.video.currentTime, 8);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

test("a native official song takes over and a delayed local stop cannot stop it", async () => {
  const player = fixture();
  await player.start();
  await player.native({ cmd: "play", url: "https://media.example.test/official.mp4", loop: false });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session", restoreDefault: false });
  assert.equal(player.video.currentSrc, "https://media.example.test/official.mp4");
  assert.equal(player.video.paused, false);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
  assert.equal(player.state.__OliviaSoulActivePlayerRevision, null);
});

test("a delayed command from a former local session cannot alter the new session revision", async () => {
  const player = fixture();
  await player.start();
  player.direct({ cmd: "play", url: `${localUrl}-new`, songId: "next-song", sessionId: "next-session", __oliviaRevision: 3 });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session" }, 2);
  assert.equal(player.state.__OliviaSoulActiveSessionId, "next-session");
  assert.equal(player.state.__OliviaSoulActivePlayerRevision, 3);
  assert.equal(player.video.paused, false);
});

test("a current-session service seek is applied and continues reporting its revision", async () => {
  const player = fixture();
  await player.start();
  await player.command({ cmd: "seek", songId: "local-song", sessionId: "local-session", offset: 80 });
  await player.advance(1);
  assert.equal(player.progress.at(-1).currentTime, 81);
  assert.equal(player.progress.at(-1).commandRevision, 2);
});

test("native stop remains available when no local session owns playback", async () => {
  const player = fixture();
  await player.native({ cmd: "play", url: "https://media.example.test/official.mp4" });
  await player.native({ cmd: "stop" });
  assert.equal(player.video.currentSrc, wallpaper);
});

test("an unreachable service permits native emergency stop", async () => {
  const player = fixture();
  await player.start();
  player.offline();
  await player.native({ cmd: "stop" });
  assert.equal(player.video.currentSrc, wallpaper);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

test("a delayed native status check cannot stop a subsequent local session", async () => {
  const player = fixture();
  await player.start();
  const respond = player.holdState();
  const oldStop = player.native({ cmd: "stop" });
  player.direct({ cmd: "play", url: `${localUrl}-new`, songId: "next-song", sessionId: "next-session", __oliviaRevision: 3 });
  respond({ songId: "local-song", sessionId: "local-session", playbackState: "stopped" });
  await oldStop;
  assert.equal(player.state.__OliviaSoulActiveSessionId, "next-session");
  assert.equal(player.video.currentSrc, `${localUrl}-new`);
  assert.equal(player.video.paused, false);
});

for (const playbackState of ["ended", "stopped"]) {
  test(`native stop is accepted when its current service session is ${playbackState}`, async () => {
    const player = fixture();
    await player.start();
    player.setState({ songId: "local-song", sessionId: "local-session", playbackState });
    await player.native({ cmd: "stop" });
    assert.equal(player.video.currentSrc, wallpaper);
    assert.equal(player.state.__OliviaSoulActiveSessionId, null);
  });
}

test("a native stop cannot borrow the terminal state of another session", async () => {
  const player = fixture();
  await player.start();
  player.setState({ songId: "former-song", sessionId: "former-session", playbackState: "ended" });
  await player.native({ cmd: "stop" });
  assert.equal(player.video.currentSrc, localUrl);
  assert.equal(player.video.paused, false);
});

test("old native seek and loop commands do not change the local session", async () => {
  const player = fixture();
  await player.start();
  await player.advance(10);
  await player.native({ cmd: "seek", offset: 350 });
  await player.native({ cmd: "setLoop", loop: true });
  assert.equal(player.video.currentTime, 10);
  assert.equal(player.video.loop, false);
});

test("an empty native event keeps the original no-op behavior", async () => {
  const player = fixture();
  await player.start();
  await player.native(null);
  assert.equal(player.video.currentSrc, localUrl);
});
