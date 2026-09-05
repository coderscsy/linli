import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the production command branch. The browser media boundary is faked;
// this tests source-reset ordering, not WebView2 decoding or real playback.
const patch = await readFile(new URL("../../tools/patch-webplayer-local.ps1", import.meta.url), "utf8");
const playBranch = patch.match(/^\$playTo = '([^\r\n]*)'\r?$/mu)?.[1];
assert.ok(playBranch, "the patch must expose its play command replacement");

function playerFixture(withVideo = true) {
  const calls = [];
  const state = {
    __OliviaSoulActivePlayerRevision: 1,
    __OliviaSoulActiveSongId: "previous-song",
    __OliviaSoulActiveSessionId: "previous-session",
    __OliviaSoulRememberDefaultPlayback(...args) { calls.push(["remember", ...args]); },
  };
  const video = {
    src: "https://media.example.test/official.mp4",
    currentSrc: "https://media.example.test/official.mp4",
    currentTime: 84,
    loop: true,
    pause() { calls.push(["pause", state.__OliviaSoulActiveSessionId]); },
    removeAttribute(name) {
      calls.push(["removeAttribute", name]);
      if (name === "src") this.src = "";
    },
    load() {
      calls.push(["load", this.src, state.__OliviaSoulActiveSessionId]);
      this.currentSrc = this.src;
      this.currentTime = 0;
    },
  };
  const context = vm.createContext({
    window: state,
    i: { value: withVideo ? video : null },
    le(url, options) { calls.push(["play", url, JSON.parse(JSON.stringify(options)), video.src, video.currentSrc]); },
  });
  return {
    calls, video, state,
    play(command) {
      context.e = { cmd: "play", ...command };
      vm.runInContext(`switch(e.cmd){${playBranch}}`, context);
    },
  };
}

const localCommand = {
  url: "http://127.0.0.1:27149/toy/midi/songs/upload/video?playSession=new-session",
  songId: "uploaded-song", sessionId: "new-session", __oliviaRevision: 2,
  mute: false, offset: 0,
};

test("switching official media to a local session unloads the old source before play", () => {
  const player = playerFixture();
  player.play(localCommand);
  assert.deepEqual(player.calls, [
    ["remember", "https://media.example.test/official.mp4", 84, true],
    ["pause", null],
    ["removeAttribute", "src"],
    ["load", "", null],
    ["play", localCommand.url, { loop: false, mute: false, offset: 0 }, "", ""],
  ]);
  assert.equal(player.state.__OliviaSoulActivePlayerRevision, 2);
  assert.equal(player.state.__OliviaSoulActiveSongId, "uploaded-song");
  assert.equal(player.state.__OliviaSoulActiveSessionId, "new-session");
});

test("a replayed local session also unloads the previous media resource", () => {
  const player = playerFixture();
  player.video.src = player.video.currentSrc = "http://127.0.0.1:27149/toy/midi/songs/upload/video?playSession=old-session";
  player.play(localCommand);
  assert.equal(player.video.currentTime, 0);
  assert.deepEqual(player.calls.slice(1, 4), [["pause", null], ["removeAttribute", "src"], ["load", "", null]]);
});

test("official and default wallpaper commands keep the native switching path", () => {
  const player = playerFixture();
  player.play({ url: "https://media.example.test/assets/wallpaper_presence/default.mp4", loop: true, offset: 12 });
  assert.deepEqual(player.calls, [
    ["remember", "https://media.example.test/assets/wallpaper_presence/default.mp4", 12, true],
    ["play", "https://media.example.test/assets/wallpaper_presence/default.mp4", { loop: true, offset: 12 },
      "https://media.example.test/official.mp4", "https://media.example.test/official.mp4"],
  ]);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

test("a local command without a mounted video still reaches the native play handler", () => {
  const player = playerFixture(false);
  assert.doesNotThrow(() => player.play(localCommand));
  assert.equal(player.calls.length, 1);
  assert.equal(player.calls[0][0], "play");
  assert.equal(player.state.__OliviaSoulActiveSessionId, "new-session");
});
