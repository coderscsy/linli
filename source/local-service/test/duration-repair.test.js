import assert from "node:assert/strict";
import test from "node:test";

import { DurationRepair } from "../midi/duration-repair.js";

test("duration repair probes missing videos with bounded concurrency and isolates failures", async () => {
  const songs = [
    { id: "one", videoPath: "external:I:\\library\\one.mp4" },
    { id: "two", videoPath: "outputs/two.mp4" },
    { id: "bad", videoPath: "outputs/bad.mp4" },
  ];
  const updates = [];
  let active = 0;
  let maximumActive = 0;
  const store = {
    listUserSongsMissingDuration: () => songs,
    resolvePath: value => value.startsWith("external:") ? value.slice(9) : `I:\\managed\\${value}`,
    updateUserSongDuration: (id, durationUs) => updates.push({ id, durationUs }),
  };
  const repair = new DurationRepair({
    store,
    concurrency: 2,
    probeVideoDurationUs: async path => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      if (path.endsWith("bad.mp4")) throw new Error("broken video");
      return path.endsWith("one.mp4") ? 10_000_000 : 20_000_000;
    },
  });

  const first = repair.start();
  const second = repair.start();
  assert.equal(first, second);
  await first;

  assert.equal(maximumActive, 2);
  assert.deepEqual(updates, [
    { id: "one", durationUs: 10_000_000 },
    { id: "two", durationUs: 20_000_000 },
  ]);
  assert.deepEqual(repair.status(), {
    state: "complete_with_errors",
    total: 3,
    completed: 2,
    failed: 1,
    lastError: "broken video",
  });
});

test("duration repair reports complete when there is no work", async () => {
  const repair = new DurationRepair({
    store: { listUserSongsMissingDuration: () => [] },
    probeVideoDurationUs: async () => 1,
  });

  await repair.start();

  assert.deepEqual(repair.status(), {
    state: "complete",
    total: 0,
    completed: 0,
    failed: 0,
    lastError: null,
  });
});
