import { parseMidi } from "midi-file";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DURATION_US = 6 * 60 * 60 * 1_000_000;
const DEFAULT_TEMPO = 500_000;

export class MidiTimelineError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "MidiTimelineError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new MidiTimelineError(code, message, cause);
}

function normalizeInput(input, maxBytes) {
  if (!(Buffer.isBuffer(input) || input instanceof Uint8Array)) {
    fail("MIDI_INVALID", "MIDI input must be a Buffer or Uint8Array");
  }
  if (input.byteLength > maxBytes) {
    fail("MIDI_TOO_LARGE", `MIDI file exceeds ${maxBytes} bytes`);
  }
  if (input.byteLength < 14 || Buffer.from(input.buffer, input.byteOffset, Math.min(input.byteLength, 4)).toString("ascii") !== "MThd") {
    fail("MIDI_INVALID", "MIDI header is missing or invalid");
  }
  return input;
}

function flattenTracks(tracks) {
  const events = [];
  let endTick = 0;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    let tick = 0;
    for (let eventIndex = 0; eventIndex < tracks[trackIndex].length; eventIndex += 1) {
      const event = tracks[trackIndex][eventIndex];
      tick += event.deltaTime;
      events.push({ event, tick, trackIndex, eventIndex });
    }
    endTick = Math.max(endTick, tick);
  }
  events.sort((left, right) => (
    left.tick - right.tick
    || left.trackIndex - right.trackIndex
    || left.eventIndex - right.eventIndex
  ));
  return { events, endTick };
}

function buildTempoMap(events, ticksPerBeat) {
  const changes = [{ tick: 0, microsecondsPerBeat: DEFAULT_TEMPO }];
  for (const item of events) {
    if (item.event.type !== "setTempo") continue;
    const value = item.event.microsecondsPerBeat;
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("MIDI_INVALID", "MIDI tempo must be a positive integer");
    }
    const last = changes.at(-1);
    if (last.tick === item.tick) {
      last.microsecondsPerBeat = value;
    } else {
      changes.push({ tick: item.tick, microsecondsPerBeat: value });
    }
  }

  let elapsedNumerator = 0n;
  for (let index = 0; index < changes.length; index += 1) {
    const current = changes[index];
    if (index > 0) {
      const previous = changes[index - 1];
      elapsedNumerator += BigInt(current.tick - previous.tick) * BigInt(previous.microsecondsPerBeat);
    }
    current.elapsedNumerator = elapsedNumerator;
  }

  const denominator = BigInt(ticksPerBeat);
  function tickToUs(tick) {
    let selected = changes[0];
    for (let index = 1; index < changes.length && changes[index].tick <= tick; index += 1) {
      selected = changes[index];
    }
    const numerator = selected.elapsedNumerator
      + BigInt(tick - selected.tick) * BigInt(selected.microsecondsPerBeat);
    const result = numerator / denominator;
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("MIDI_TOO_LONG", "MIDI duration exceeds the safe integer range");
    }
    return Number(result);
  }

  return { changes, tickToUs };
}

function queueFor(map, key) {
  let queue = map.get(key);
  if (!queue) {
    queue = [];
    map.set(key, queue);
  }
  return queue;
}

function closeDeferredNotes(deferred, channel, tick) {
  for (const [key, notes] of deferred) {
    if (!key.startsWith(`${channel}:`)) continue;
    for (const note of notes) note.endTick = tick;
    deferred.delete(key);
  }
}

function collectPerformance(events, endTick) {
  const active = new Map();
  const deferred = new Map();
  const sustainDown = Array(16).fill(false);
  const notes = [];
  const pedals = [];
  const warnings = [];

  for (const { event, tick } of events) {
    if (event.type === "noteOn") {
      const note = {
        startTick: tick,
        endTick: null,
        channel: event.channel,
        note: event.noteNumber,
        velocity: event.velocity,
      };
      queueFor(active, `${event.channel}:${event.noteNumber}`).push(note);
      notes.push(note);
      continue;
    }

    if (event.type === "noteOff") {
      const key = `${event.channel}:${event.noteNumber}`;
      const queue = active.get(key);
      const note = queue?.shift();
      if (!note) continue;
      if (queue.length === 0) active.delete(key);
      if (sustainDown[event.channel]) {
        queueFor(deferred, key).push(note);
      } else {
        note.endTick = tick;
      }
      continue;
    }

    if (event.type === "controller" && event.controllerType === 64) {
      const down = event.value >= 64;
      pedals.push({ tick, channel: event.channel, down, value: event.value });
      if (sustainDown[event.channel] && !down) {
        closeDeferredNotes(deferred, event.channel, tick);
      }
      sustainDown[event.channel] = down;
    }
  }

  for (const queue of active.values()) {
    for (const note of queue) {
      note.endTick = endTick;
      warnings.push({ code: "DANGLING_NOTE", channel: note.channel, note: note.note });
    }
  }
  for (const queue of deferred.values()) {
    for (const note of queue) {
      note.endTick = endTick;
      warnings.push({ code: "SUSTAIN_NOT_RELEASED", channel: note.channel, note: note.note });
    }
  }

  return { notes, pedals, warnings };
}

export function parseMidiTimeline(input, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDurationUs = options.maxDurationUs ?? DEFAULT_MAX_DURATION_US;
  normalizeInput(input, maxBytes);

  let parsed;
  try {
    parsed = parseMidi(input);
  } catch (error) {
    fail("MIDI_INVALID", "MIDI structure could not be parsed", error);
  }

  if (parsed.header.format !== 0 && parsed.header.format !== 1) {
    fail("MIDI_FORMAT_UNSUPPORTED", `MIDI format ${parsed.header.format} is not supported`);
  }
  if (!Number.isSafeInteger(parsed.header.ticksPerBeat) || parsed.header.ticksPerBeat <= 0) {
    fail("MIDI_TIMING_UNSUPPORTED", "SMPTE MIDI timing is not supported");
  }
  if (parsed.tracks.length !== parsed.header.numTracks) {
    fail("MIDI_INVALID", "MIDI track count does not match its header");
  }

  const { events, endTick } = flattenTracks(parsed.tracks);
  const tempoMap = buildTempoMap(events, parsed.header.ticksPerBeat);
  const durationUs = tempoMap.tickToUs(endTick);
  if (durationUs > maxDurationUs) {
    fail("MIDI_TOO_LONG", `MIDI duration exceeds ${maxDurationUs} microseconds`);
  }

  const performance = collectPerformance(events, endTick);
  const notes = performance.notes
    .map((note) => ({
      startUs: tempoMap.tickToUs(note.startTick),
      endUs: tempoMap.tickToUs(note.endTick),
      channel: note.channel,
      note: note.note,
      velocity: note.velocity,
    }))
    .sort((left, right) => left.startUs - right.startUs || left.channel - right.channel || left.note - right.note);

  return {
    durationUs,
    notes,
    pedals: performance.pedals.map((pedal) => ({
      atUs: tempoMap.tickToUs(pedal.tick),
      channel: pedal.channel,
      down: pedal.down,
      value: pedal.value,
    })),
    tempoChanges: tempoMap.changes.map((change) => ({
      atUs: tempoMap.tickToUs(change.tick),
      microsecondsPerBeat: change.microsecondsPerBeat,
    })),
    warnings: performance.warnings,
    metadata: {
      format: parsed.header.format,
      ticksPerBeat: parsed.header.ticksPerBeat,
      trackCount: parsed.header.numTracks,
    },
  };
}

