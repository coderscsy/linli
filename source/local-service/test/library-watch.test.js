import assert from "node:assert/strict";
import test from "node:test";

import { watchPerformanceLibrary } from "../midi/library-watch.js";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("library watcher requests recursive watching and debounces file bursts", async () => {
  const calls = [];
  let listener;
  let closed = false;
  const watchImpl = (root, options, callback) => {
    calls.push({ root, options });
    listener = callback;
    return {
      close() { closed = true; },
      on() { return this; },
    };
  };
  let changes = 0;
  const watcher = watchPerformanceLibrary({
    root: "I:\\MusicLibrary",
    debounceMs: 15,
    watchImpl,
    onChange: () => { changes += 1; },
  });

  assert.deepEqual(calls, [{
    root: "I:\\MusicLibrary",
    options: { recursive: true, persistent: false },
  }]);
  listener("rename", "midi_1/video.mp4");
  listener("change", "midi_1/video.mp4");
  await delay(40);
  assert.equal(changes, 1);

  watcher.close();
  assert.equal(closed, true);
});

test("library watcher falls back when recursive watching is unavailable", () => {
  const calls = [];
  const watchImpl = (root, options) => {
    calls.push(options);
    if (options.recursive) throw new Error("recursive unsupported");
    return { close() {}, on() { return this; } };
  };
  const watcher = watchPerformanceLibrary({
    root: "/library",
    onChange() {},
    watchImpl,
  });
  assert.deepEqual(calls, [
    { recursive: true, persistent: false },
    { recursive: false, persistent: false },
  ]);
  watcher.close();
});
