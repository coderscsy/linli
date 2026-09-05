import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

const patch = await readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8");
const directControl = patch.match(/^\$directControlTo = '([^\r\n]*)'\r?$/mu)?.[1]
  ?.replaceAll("' + $playerCommandUrl + '", "http://test/toy/player-command")
  .replaceAll("' + $playerStateUrl + '", "http://test/toy/player-state");
assert.ok(directControl, "the patch must expose its production control bridge");

// Execute the real FE bridge. Only HTTP/native transport is replaced: a play
// reaches the service immediately, while its response can arrive after Stop.
function playerFixture({ acceptPlay = true, deferState = false } = {}) {
  const requests = [];
  const stateRequests = [];
  const nativeCommands = [];
  const pendingResponses = [];
  const pendingStateResponses = [];
  const timers = new Map();
  let timerNumber = 0;
  let elapsedTime = 0;
  const state = { __OliviaSoulSessionEpoch: 0 };
  const service = { songId: null, sessionId: null, playbackState: "stopped" };
  let revision = 0;
  let sessionNumber = 0;
  const response = (command, ok = true) => ({
    ok, status: ok ? 200 : 409,
    json: async () => ok
      ? { code: 0, message: "success", data: { revision: ++revision, command } }
      : { code: 409, message: "current session changed" },
  });
  const context = vm.createContext({
    window: state,
    setTimeout(callback, delay) { const id = ++timerNumber; timers.set(id, { callback, due: elapsedTime + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    We: async ({ data }) => { nativeCommands.push(JSON.parse(JSON.stringify(data))); },
    fetch: async (url, options) => {
      if (url === "http://test/toy/player-state") {
        stateRequests.push({ url, ...options });
        const stateResponse = data => ({ ok: true, status: 200, json: async () => ({ code: 0, message: "success", data }) });
        if (deferState) return new Promise(resolve => pendingStateResponses.push(data => resolve(stateResponse(data))));
        return stateResponse({ ...service });
      }
      const command = JSON.parse(options.body);
      requests.push(command);
      if (command.cmd === "play") {
        const accepted = { ...command, sessionId: `session-${++sessionNumber}`, loop: false };
        if (acceptPlay) Object.assign(service, { songId: command.songId, sessionId: accepted.sessionId, playbackState: "playing" });
        return new Promise((resolve, reject) => {
          pendingResponses.push({ resolve: () => resolve(response(accepted)), reject });
        });
      }
      if (!command.sessionId || command.songId !== service.songId || command.sessionId !== service.sessionId)
        return response(command, false);
      if (command.cmd === "stop") service.playbackState = "stopped";
      return response(command);
    },
  });
  vm.runInContext(directControl, context);
  return {
    requests, stateRequests, nativeCommands, state, service,
    command(command) { return context.Ct(command); },
    begin(songId = "local-song") {
      state.__OliviaSoulSongId = songId;
      state.__OliviaSoulSessionId = null;
      state.__OliviaSoulCommandRevision = null;
      state.__OliviaSoulSessionEpoch++;
      return context.Ct({ cmd: "play", song: { id: songId, videoUrl: `http://test/toy/midi/songs/${songId}/video`, name: songId } });
    },
    clearStoppedUi() {
      state.__OliviaSoulSongId = null;
      state.__OliviaSoulSessionId = null;
      state.__OliviaSoulCommandRevision = null;
      state.__OliviaSoulSessionEpoch++;
    },
    resolvePlay(index = 0) { pendingResponses[index].resolve(); },
    rejectPlay(error, index = 0) { pendingResponses[index].reject(error); },
    resolveState(data = { ...service }, index = 0) { pendingStateResponses[index](data); },
    advanceTime(milliseconds) {
      elapsedTime += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.due > elapsedTime) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function outcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

test("stop waits for its pending play session even after the UI clears local ownership", async () => {
  const player = playerFixture();
  const playing = player.begin();
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  await nextTurn();
  const beforeReply = [...player.requests];
  player.resolvePlay();
  await playing;
  const result = await stopping;

  assert.deepEqual(beforeReply.map(command => command.cmd), ["play"], "stop must not send an empty session");
  assert.equal(result.error, undefined);
  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "local-song", sessionId: "session-1" });
  assert.equal(player.service.playbackState, "stopped");
  assert.equal(player.state.__OliviaSoulSongId, null);
  assert.equal(player.state.__OliviaSoulSessionId, null, "a late play response must not revive stopped UI state");
});

test("a deferred stop retains the old session when a new local song starts", async () => {
  const player = playerFixture();
  const oldPlaying = player.begin("old-song");
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  const newPlaying = player.begin("new-song");
  player.resolvePlay(1);
  await newPlaying;
  player.resolvePlay(0);
  await oldPlaying;
  await stopping;

  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "old-song", sessionId: "session-1" });
  assert.equal(player.service.playbackState, "playing");
  assert.equal(player.service.sessionId, "session-2");
  assert.equal(player.state.__OliviaSoulSongId, "new-song");
  assert.equal(player.state.__OliviaSoulSessionId, "session-2");
});

test("same-song replay stops the newest pending generation rather than the first play", async () => {
  const player = playerFixture();
  const firstPlaying = player.begin();
  const replaying = player.command({ cmd: "play", song: { id: "local-song", videoUrl: "http://test/toy/midi/songs/local-song/video" } });
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  player.resolvePlay(0);
  await firstPlaying;
  await nextTurn();
  const beforeReplayReply = [...player.requests];
  player.resolvePlay(1);
  await replaying;
  const result = await stopping;

  assert.deepEqual(beforeReplayReply.map(command => command.cmd), ["play", "play"]);
  assert.equal(result.error, undefined);
  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "local-song", sessionId: "session-2" });
  assert.equal(player.service.playbackState, "stopped");
});

test("a settled local session still stops immediately", async () => {
  const player = playerFixture();
  const playing = player.begin();
  player.resolvePlay();
  await playing;
  await player.command({ cmd: "stop" });
  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "local-song", sessionId: "session-1" });
  assert.equal(player.service.playbackState, "stopped");
  assert.deepEqual(player.nativeCommands, [{ cmd: "stop" }]);
});

test("switching a settled local song to an official song keeps the native handoff", async () => {
  const player = playerFixture();
  const playing = player.begin();
  player.resolvePlay();
  await playing;
  const official = { cmd: "play", song: { id: "official-song", videoUrl: "https://media.test/official.mp4" } };
  await player.command(official);
  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "local-song", sessionId: "session-1", restoreDefault: false });
  assert.deepEqual(player.nativeCommands, [official]);
  assert.equal(player.state.__OliviaSoulSongId, null);
});

test("a play that was never accepted cannot manufacture a stop session after response failure", async () => {
  const player = playerFixture({ acceptPlay: false });
  const playing = outcome(player.begin());
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  player.rejectPlay(new Error("play transport failed"));
  const [playResult, stopResult] = await Promise.all([playing, stopping]);
  assert.equal(playResult.error.message, "play transport failed");
  assert.ok(stopResult.error);
  assert.deepEqual(player.requests.map(command => command.cmd), ["play"]);
  assert.deepEqual(player.nativeCommands, [{ cmd: "stop" }], "the native emergency stop remains immediate");
});

test("stop recovers the accepted play session when the play response is lost", async () => {
  const player = playerFixture();
  const playing = outcome(player.begin());
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  player.rejectPlay(new Error("play response lost"));
  await playing;
  const result = await stopping;

  assert.equal(result.error, undefined);
  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "local-song", sessionId: "session-1" });
  assert.equal(player.service.playbackState, "stopped", "the HTTP stop must close the accepted session");
  assert.equal(player.state.__OliviaSoulSongId, null);
  assert.equal(player.state.__OliviaSoulSessionId, null);
});

test("stop recovers after a bounded wait when the accepted play response never settles", async () => {
  const player = playerFixture();
  const playing = player.begin();
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  player.advanceTime(1499);
  await nextTurn();
  assert.equal(player.stateRequests.length, 0, "allow the play response its bounded wait before recovery");
  player.advanceTime(1);
  await nextTurn();
  assert.equal(player.stateRequests.length, 1, "a pending response must not block Stop forever");
  const result = await stopping;
  assert.equal(result.error, undefined);
  assert.deepEqual(player.requests.at(-1), { cmd: "stop", songId: "local-song", sessionId: "session-1" });
  assert.equal(player.service.playbackState, "stopped");
  player.resolvePlay();
  await playing;
  assert.equal(player.state.__OliviaSoulSessionId, null);
});

test("recovery cannot borrow a new same-song session that starts while its state query is pending", async () => {
  const player = playerFixture({ deferState: true });
  const oldPlaying = outcome(player.begin());
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.clearStoppedUi();
  player.rejectPlay(new Error("play response lost"));
  await oldPlaying;
  await nextTurn();
  assert.equal(player.stateRequests.length, 1);
  const newPlaying = player.begin();
  player.resolvePlay(1);
  await newPlaying;
  player.resolveState();
  await stopping;

  assert.deepEqual(player.requests.map(command => command.cmd), ["play", "play"]);
  assert.equal(player.service.playbackState, "playing");
  assert.equal(player.service.sessionId, "session-2");
  assert.equal(player.state.__OliviaSoulSessionId, "session-2");
});

test("recovery cannot borrow a replay session even if replay did not change the FE epoch", async () => {
  const player = playerFixture({ deferState: true });
  const oldPlaying = outcome(player.begin());
  const stopping = outcome(player.command({ cmd: "stop" }));
  player.rejectPlay(new Error("play response lost"));
  await oldPlaying;
  await nextTurn();
  assert.equal(player.stateRequests.length, 1);
  const replaying = player.command({ cmd: "play", song: { id: "local-song", videoUrl: "http://test/toy/midi/songs/local-song/video" } });
  player.resolvePlay(1);
  await replaying;
  player.resolveState();
  await stopping;

  assert.deepEqual(player.requests.map(command => command.cmd), ["play", "play"]);
  assert.equal(player.service.playbackState, "playing");
  assert.equal(player.service.sessionId, "session-2");
  assert.equal(player.state.__OliviaSoulSessionId, "session-2");
});
