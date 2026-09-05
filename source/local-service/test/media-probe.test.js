import assert from "node:assert/strict";
import test from "node:test";

import { createVideoDurationProbe } from "../midi/media-probe.js";

test("video duration probe returns integer microseconds and exact ffprobe arguments", async () => {
  const calls = [];
  const probe = createVideoDurationProbe({
    command: "I:\\runtime\\ffprobe.exe",
    runProcess: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({
        format: { duration: "192.470000" },
        streams: [
          { codec_type: "video", codec_name: "h264" },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }) };
    },
  });

  assert.equal(await probe("I:\\music\\song.mp4"), 192_470_000);
  assert.deepEqual(calls, [[
    "I:\\runtime\\ffprobe.exe",
    ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name", "-of", "json", "I:\\music\\song.mp4"],
    { timeoutMs: 30_000 },
  ]]);
});

for (const stdout of [
  "not-json",
  JSON.stringify({ format: { duration: "0" }, streams: [{ codec_type: "video", codec_name: "h264" }] }),
  JSON.stringify({ format: { duration: "NaN" }, streams: [{ codec_type: "video", codec_name: "h264" }] }),
  JSON.stringify({ format: { duration: "12" }, streams: [{ codec_type: "audio", codec_name: "aac" }] }),
  JSON.stringify({ format: { duration: "12" }, streams: [{ codec_type: "video", codec_name: "hevc" }] }),
]) {
  test(`video duration probe rejects invalid metadata: ${stdout}`, async () => {
    const probe = createVideoDurationProbe({
      command: "ffprobe.exe",
      runProcess: async () => ({ stdout }),
    });
    await assert.rejects(probe("broken.mp4"), { code: "VIDEO_DURATION_INVALID" });
  });
}

test("video duration probe maps timeout and unavailable process errors", async () => {
  const timeoutProbe = createVideoDurationProbe({
    command: "ffprobe.exe",
    runProcess: async () => { throw Object.assign(new Error("timed out"), { code: "PROCESS_TIMEOUT" }); },
  });
  await assert.rejects(timeoutProbe("slow.mp4"), { code: "VIDEO_PROBE_TIMEOUT" });

  const missingProbe = createVideoDurationProbe({
    command: "ffprobe.exe",
    runProcess: async () => { throw Object.assign(new Error("missing"), { code: "PROCESS_START_FAILED" }); },
  });
  await assert.rejects(missingProbe("missing.mp4"), { code: "VIDEO_PROBE_UNAVAILABLE" });
});
