import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { redactSecrets } from "./redaction.js";

const PROTOCOL_MARKER = /LivePlayer|RenderPlay|PerformanceManager|startPlayingMusic|updatePlan|render_ready|switch_ready|event_(?:name|param)|Cmd\.|ProtoGen|TPRender|ovilia_Win64/iu;
const PATH_MARKER = /(?:[A-Z]:\\|wallpaper\\|TPRender\\|\.proto\b|\.pdb\b)/iu;
const MESSAGE_MARKER = /Notify|Reply|event_name|event_param/iu;
const JWT = /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/u;
const SECRET_SIGNAL = /\b(?:x-token|authorization|cookie|set-cookie|model_gateway_token)\b|\bBearer\b|[?&](?:token|api_key)=|\b(?:token|api_key)\s*[:=]/iu;
const MIN_STRING_LENGTH = 4;
const DEFAULT_MAX_STRING_LENGTH = 4096;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_STRING_LENGTH = 64 * 1024;

export function extractPrintableStrings(buffer, { maxStringLength = DEFAULT_MAX_STRING_LENGTH, scanComplete = true } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer 必须是 Buffer");
  if (!Number.isSafeInteger(maxStringLength) || maxStringLength < MIN_STRING_LENGTH || maxStringLength > MAX_STRING_LENGTH) {
    throw new RangeError(`maxStringLength 必须介于 ${MIN_STRING_LENGTH} 和 ${MAX_STRING_LENGTH}`);
  }
  if (typeof scanComplete !== "boolean") throw new TypeError("scanComplete 必须是布尔值");

  const ascii = extractAscii(buffer, maxStringLength, scanComplete);
  return [...ascii.strings, ...extractUtf16Le(buffer, maxStringLength, ascii.terminators, scanComplete)]
    .sort(compareOffset);
}

export async function collectProtocolEvidence(files, { maxScanBytes = DEFAULT_MAX_SCAN_BYTES, maxStringLength = DEFAULT_MAX_STRING_LENGTH } = {}) {
  if (!Array.isArray(files)) throw new TypeError("files 必须是数组");
  if (!files.every(file => typeof file === "string")) throw new TypeError("files 必须仅包含字符串路径");
  if (!Number.isSafeInteger(maxScanBytes) || maxScanBytes < 0) throw new RangeError("maxScanBytes 必须是非负安全整数");
  if (maxScanBytes > DEFAULT_MAX_SCAN_BYTES) throw new RangeError(`maxScanBytes 不得超过 ${DEFAULT_MAX_SCAN_BYTES}`);

  const collected = [];
  for (const file of [...files].sort(compareText)) {
    const result = await inspectFile(file, { maxScanBytes, maxStringLength });
    collected.push(result);
  }

  const records = collected.flatMap(file => file.matches?.map(match => ({ ...match, file: file.path })) ?? []);
  const unique = deduplicate(records, record => `${record.encoding}\u0000${record.value}`, compareLowestOffset);
  const markers = unique.filter(record => PROTOCOL_MARKER.test(record.value));
  const messages = unique.filter(record => MESSAGE_MARKER.test(record.value));
  const paths = unique.filter(record => PATH_MARKER.test(record.value));

  return {
    files: collected.sort((left, right) => compareText(left.path, right.path)),
    markers: markers.sort(compareRecord),
    messages: messages.sort(compareRecord),
    paths: paths.sort(compareRecord),
  };
}

async function inspectFile(file, options) {
  const safePath = sanitizePath(file);
  try {
    const { sha256, scanned, scanComplete, size } = await hashAndReadBounded(file, options.maxScanBytes);
    const matches = deduplicate(
      extractPrintableStrings(scanned, { ...options, scanComplete })
        .map(sanitizeMatch)
        .filter(Boolean)
        .filter(match => PROTOCOL_MARKER.test(match.value) || PATH_MARKER.test(match.value)),
      match => `${match.encoding}\u0000${match.value}`,
    ).sort(compareOffset);
    return { path: safePath, size, sha256, matches };
  } catch {
    return { path: safePath, error: "read_failed" };
  }
}

async function hashAndReadBounded(file, maxScanBytes) {
  const handle = await open(file, "r");
  try {
    return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const chunks = [];
    let scannedLength = 0;
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    stream.on("data", chunk => {
      hash.update(chunk);
      size += chunk.length;
      if (scannedLength >= maxScanBytes) return;
      const retained = chunk.subarray(0, maxScanBytes - scannedLength);
      chunks.push(retained);
      scannedLength += retained.length;
    });
    stream.once("error", reject);
    stream.once("end", () => resolve({
      sha256: hash.digest("hex"),
      scanned: Buffer.concat(chunks, scannedLength),
      scanComplete: size <= maxScanBytes,
      size,
    }));
    });
  } finally {
    await handle.close();
  }
}

function extractAscii(buffer, maxStringLength, scanComplete) {
  const strings = [];
  const terminators = new Set();
  for (let index = 0; index < buffer.length;) {
    if (!isPrintable(buffer[index])) {
      index += 1;
      continue;
    }
    const offset = index;
    let value = "";
    while (index < buffer.length && isPrintable(buffer[index])) {
      if (value.length < maxStringLength) value += String.fromCharCode(buffer[index]);
      index += 1;
    }
    if (value.length >= MIN_STRING_LENGTH && (scanComplete || index < buffer.length)) {
      strings.push({ encoding: "ascii", offset, value });
      if (buffer[index] === 0) terminators.add(index);
    }
  }
  return { strings, terminators };
}

function* extractUtf16Le(buffer, maxStringLength, asciiTerminators, scanComplete) {
  for (let index = 0; index + 1 < buffer.length;) {
    if (!isPrintable(buffer[index]) || buffer[index + 1] !== 0 || asciiTerminators.has(index + 1) || isUtf16Continuation(buffer, index, asciiTerminators)) {
      index += 1;
      continue;
    }
    const offset = index;
    let value = "";
    while (index + 1 < buffer.length && isPrintable(buffer[index]) && buffer[index + 1] === 0) {
      if (value.length < maxStringLength) value += String.fromCharCode(buffer[index]);
      index += 2;
    }
    if (value.length >= MIN_STRING_LENGTH && (scanComplete || index + 1 < buffer.length)) {
      yield { encoding: "utf16le", offset, value };
    }
  }
}

function sanitizeMatch(match) {
  const value = sanitizeValue(match.value);
  return value ? { ...match, value } : null;
}

function sanitizeValue(value) {
  const redacted = redactSecrets(value);
  if (value.length < MIN_STRING_LENGTH || redacted === "[REDACTED]" || hasCredentialSignal(value)) return null;
  return redacted;
}

function sanitizePath(value) {
  const redacted = redactSecrets(value);
  if (redacted === "[REDACTED]" || hasCredentialSignal(value)) return "[REDACTED]";
  return value
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/]+/iu, "$1[REDACTED]")
    .replace(/([\\/]Users[\\/])[^\\/]+/iu, "$1[REDACTED]");
}

function hasCredentialSignal(value) {
  return SECRET_SIGNAL.test(value) || JWT.test(value);
}

function isUtf16Continuation(buffer, index, asciiTerminators) {
  return index >= 2
    && isPrintable(buffer[index - 2])
    && buffer[index - 1] === 0
    && !asciiTerminators.has(index - 1);
}

function deduplicate(values, keyFor, compare = compareRecord) {
  const seen = new Map();
  for (const value of values) {
    const key = keyFor(value);
    const previous = seen.get(key);
    if (!previous || compare(value, previous) < 0) seen.set(key, value);
  }
  return [...seen.values()];
}

function isPrintable(byte) {
  return byte >= 0x20 && byte <= 0x7e;
}

function compareOffset(left, right) {
  return left.offset - right.offset || left.encoding.localeCompare(right.encoding);
}

function compareRecord(left, right) {
  return compareText(left.file, right.file) || compareOffset(left, right);
}

function compareLowestOffset(left, right) {
  return compareOffset(left, right) || compareText(left.file, right.file);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
