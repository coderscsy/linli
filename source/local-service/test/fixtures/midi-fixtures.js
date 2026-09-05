function u16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function ascii(value) {
  return [...Buffer.from(value, "ascii")];
}

export function variableLength(value) {
  const bytes = [value & 0x7f];
  let remaining = value >>> 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return bytes;
}

export function noteOn(delta, note, velocity, channel = 0) {
  return [...variableLength(delta), 0x90 | channel, note, velocity];
}

export function noteOff(delta, note, velocity = 0, channel = 0) {
  return [...variableLength(delta), 0x80 | channel, note, velocity];
}

export function controlChange(delta, controller, value, channel = 0) {
  return [...variableLength(delta), 0xb0 | channel, controller, value];
}

export function tempo(delta, microsecondsPerBeat) {
  return [
    ...variableLength(delta),
    0xff,
    0x51,
    0x03,
    (microsecondsPerBeat >>> 16) & 0xff,
    (microsecondsPerBeat >>> 8) & 0xff,
    microsecondsPerBeat & 0xff,
  ];
}

export function endOfTrack(delta = 0) {
  return [...variableLength(delta), 0xff, 0x2f, 0x00];
}

export function track(...events) {
  const body = events.flat();
  return [...ascii("MTrk"), ...u32(body.length), ...body];
}

export function midiFile({ format = 0, ticksPerBeat = 480, tracks }) {
  const header = [
    ...ascii("MThd"),
    ...u32(6),
    ...u16(format),
    ...u16(tracks.length),
    ...u16(ticksPerBeat),
  ];
  return Buffer.from([...header, ...tracks.flat()]);
}

