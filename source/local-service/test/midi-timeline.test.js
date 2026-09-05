import assert from "node:assert/strict";
import test from "node:test";

import { parseMidiTimeline } from "../midi/timeline.js";
import {
  controlChange,
  endOfTrack,
  midiFile,
  noteOff,
  noteOn,
  tempo,
  track,
} from "./fixtures/midi-fixtures.js";

test("MIDI timeline parses format 0 into exact integer microseconds", () => {
  const input = midiFile({
    tracks: [track(noteOn(0, 60, 96), noteOff(480, 60), endOfTrack())],
  });

  const result = parseMidiTimeline(input);

  assert.equal(result.durationUs, 500_000);
  assert.deepEqual(result.notes, [{
    startUs: 0,
    endUs: 500_000,
    channel: 0,
    note: 60,
    velocity: 96,
  }]);
  assert.deepEqual(result.tempoChanges, [{ atUs: 0, microsecondsPerBeat: 500_000 }]);
  assert.deepEqual(result.metadata, { format: 0, ticksPerBeat: 480, trackCount: 1 });
});

test("MIDI timeline merges format 1 tempo and note tracks", () => {
  const input = midiFile({
    format: 1,
    tracks: [
      track(tempo(0, 500_000), tempo(480, 1_000_000), endOfTrack()),
      track(noteOn(0, 64, 80), noteOff(960, 64), endOfTrack()),
    ],
  });

  const result = parseMidiTimeline(input);

  assert.equal(result.durationUs, 1_500_000);
  assert.equal(result.notes[0].endUs, 1_500_000);
  assert.deepEqual(result.tempoChanges, [
    { atUs: 0, microsecondsPerBeat: 500_000 },
    { atUs: 500_000, microsecondsPerBeat: 1_000_000 },
  ]);
});

test("MIDI timeline treats note-on velocity zero as note-off and pairs overlaps FIFO", () => {
  const input = midiFile({
    tracks: [track(
      noteOn(0, 60, 50),
      noteOn(120, 60, 80),
      noteOn(120, 60, 0),
      noteOff(120, 60),
      endOfTrack(),
    )],
  });

  assert.deepEqual(parseMidiTimeline(input).notes, [
    { startUs: 0, endUs: 250_000, channel: 0, note: 60, velocity: 50 },
    { startUs: 125_000, endUs: 375_000, channel: 0, note: 60, velocity: 80 },
  ]);
});

test("MIDI timeline extends released notes until sustain pedal up", () => {
  const input = midiFile({
    tracks: [track(
      noteOn(0, 60, 90),
      controlChange(240, 64, 127),
      noteOff(240, 60),
      controlChange(240, 64, 0),
      endOfTrack(),
    )],
  });

  const result = parseMidiTimeline(input);

  assert.equal(result.notes[0].endUs, 750_000);
  assert.deepEqual(result.pedals, [
    { atUs: 250_000, channel: 0, down: true, value: 127 },
    { atUs: 750_000, channel: 0, down: false, value: 0 },
  ]);
});

test("MIDI timeline closes dangling notes at track end with a warning", () => {
  const input = midiFile({ tracks: [track(noteOn(0, 72, 70), endOfTrack(480))] });

  const result = parseMidiTimeline(input);

  assert.equal(result.notes[0].endUs, 500_000);
  assert.deepEqual(result.warnings, [{ code: "DANGLING_NOTE", channel: 0, note: 72 }]);
});

test("MIDI timeline rejects unsafe or unsupported input with stable codes", () => {
  const format2 = midiFile({ format: 2, tracks: [track(endOfTrack())] });
  const valid = midiFile({ tracks: [track(noteOn(0, 60, 1), noteOff(480, 60), endOfTrack())] });

  assert.throws(() => parseMidiTimeline(format2), { code: "MIDI_FORMAT_UNSUPPORTED" });
  assert.throws(() => parseMidiTimeline(Buffer.from("not-midi")), { code: "MIDI_INVALID" });
  assert.throws(() => parseMidiTimeline(valid, { maxBytes: 8 }), { code: "MIDI_TOO_LARGE" });
  assert.throws(() => parseMidiTimeline(valid, { maxDurationUs: 100_000 }), { code: "MIDI_TOO_LONG" });
});

