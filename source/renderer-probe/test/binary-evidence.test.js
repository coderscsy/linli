import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectProtocolEvidence, extractPrintableStrings } from "../src/binary-evidence.js";

test("extracts ASCII and UTF-16LE markers with their byte offsets", () => {
  const buffer = Buffer.concat([
    Buffer.from("xxxxLivePlayerStartNotify\0", "ascii"),
    Buffer.from("render_ready\0", "utf16le"),
  ]);

  assert.deepEqual(extractPrintableStrings(buffer), [
    { encoding: "ascii", offset: 0, value: "xxxxLivePlayerStartNotify" },
    { encoding: "utf16le", offset: 26, value: "render_ready" },
  ]);
});

test("extracts complete UTF-16LE strings at odd and even offsets after printable noise", () => {
  const oddOffset = Buffer.concat([Buffer.from("X", "ascii"), Buffer.from("render_ready", "utf16le"), Buffer.from([0])]);
  const evenOffset = Buffer.concat([Buffer.from("XY", "ascii"), Buffer.from("switch_ready", "utf16le"), Buffer.from([0])]);

  assert.deepEqual(extractPrintableStrings(oddOffset), [
    { encoding: "utf16le", offset: 1, value: "render_ready" },
  ]);
  assert.deepEqual(extractPrintableStrings(evenOffset), [
    { encoding: "utf16le", offset: 2, value: "switch_ready" },
  ]);
});

test("limits extracted string length without decoding an unbounded run", () => {
  const buffer = Buffer.from("LivePlayer".repeat(10), "ascii");

  assert.deepEqual(extractPrintableStrings(buffer, { maxStringLength: 12 }), [
    { encoding: "ascii", offset: 0, value: "LivePlayerLi" },
  ]);
});

test("collects sorted, deduplicated protocol evidence and classifies paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const later = join(root, "z.dll");
    const earlier = join(root, "a.dll");
    await writeFile(later, Buffer.from("LivePlayerReply\0C:\\wallpaper\\TPRender\\schema.proto\0", "ascii"));
    await writeFile(earlier, Buffer.from("LivePlayerReply\0LivePlayerReply\0", "ascii"));

    const evidence = await collectProtocolEvidence([later, earlier]);
    assert.equal(evidence.files[0].path.endsWith("\\a.dll"), true);
    assert.equal(evidence.files[1].path.endsWith("\\z.dll"), true);
    assert.deepEqual(evidence.messages, [
      { encoding: "ascii", file: evidence.files[0].path, offset: 0, value: "LivePlayerReply" },
    ]);
    assert.deepEqual(evidence.paths, [
      { encoding: "ascii", file: evidence.files[1].path, offset: 16, value: "C:\\wallpaper\\TPRender\\schema.proto" },
    ]);
    assert.equal(evidence.files[0].matches.length, 1);
    assert.match(evidence.files[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(evidence.files[0].size, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol evidence omits every allowlisted string containing a credential signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const signals = [
      "x-token=value",
      "Authorization: Bearer value",
      "Cookie=value",
      "model_gateway_token=value",
      "?token=value",
      "api_key=value",
      ["aaa", "bbb", "ccc"].join("."),
    ];
    const files = await Promise.all(signals.map(async (signal, index) => {
      const file = join(root, `NutLivePlayer-${index}.dll`);
      await writeFile(file, `Cmd.LivePlayerCtrlNotify.event_name ${signal}`);
      return file;
    }));

    const evidence = await collectProtocolEvidence(files);
    const serialized = JSON.stringify(evidence);
    assert.deepEqual(evidence.markers, []);
    assert.doesNotMatch(serialized, /LivePlayerCtrlNotify|x-token|authorization|cookie|model_gateway_token|aaa\.bbb\.ccc/ui);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns deterministic safe read errors without exposing filesystem error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const unavailable = join(root, "missing.dll");
    const evidence = await collectProtocolEvidence([unavailable]);

    assert.equal(evidence.files.length, 1);
    assert.equal(evidence.files[0].error, "read_failed");
    assert.doesNotMatch(JSON.stringify(evidence), /sycan/u);
    assert.deepEqual(evidence.markers, []);
    assert.deepEqual(evidence.messages, []);
    assert.deepEqual(evidence.paths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hashes the complete file but limits protocol scanning to maxScanBytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const file = join(root, "large.dll");
    const content = Buffer.concat([Buffer.alloc(128 * 1024, 0), Buffer.from("LivePlayerStartNotify", "ascii")]);
    await writeFile(file, content);

    const evidence = await collectProtocolEvidence([file], { maxScanBytes: 1024 });
    assert.deepEqual(evidence.markers, []);
    assert.equal(evidence.files[0].size, content.length);
    assert.equal(evidence.files[0].sha256, createHash("sha256").update(content).digest("hex"));
    await assert.rejects(() => collectProtocolEvidence([file], { maxScanBytes: -1 }), /非负安全整数/u);
    await assert.rejects(() => collectProtocolEvidence([file], { maxScanBytes: 17 * 1024 * 1024 }), /不得超过/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omits ASCII and UTF-16LE runs that reach an incomplete scan window", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const ascii = join(root, "ascii.dll");
    const utf16 = join(root, "utf16.dll");
    const halfCodeUnit = join(root, "half-code-unit.dll");
    const asciiMarker = Buffer.from("LivePlayerStartNotify", "ascii");
    const utf16Marker = Buffer.from("render_ready", "utf16le");
    await writeFile(ascii, Buffer.concat([asciiMarker, Buffer.from(" x-token=value", "ascii")]));
    await writeFile(utf16, Buffer.concat([utf16Marker, Buffer.from(" x-token=value", "utf16le")]));
    await writeFile(halfCodeUnit, Buffer.concat([utf16Marker, Buffer.from("x", "utf16le")]));

    const [asciiEvidence, utf16Evidence, halfEvidence] = await Promise.all([
      collectProtocolEvidence([ascii], { maxScanBytes: asciiMarker.length }),
      collectProtocolEvidence([utf16], { maxScanBytes: utf16Marker.length }),
      collectProtocolEvidence([halfCodeUnit], { maxScanBytes: utf16Marker.length + 1 }),
    ]);
    for (const evidence of [asciiEvidence, utf16Evidence, halfEvidence]) {
      assert.deepEqual(evidence.markers, []);
      assert.doesNotMatch(JSON.stringify(evidence), /LivePlayerStartNotify|render_ready/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-string paths without invoking user conversion", async () => {
  let converted = false;
  const malicious = {
    toString() {
      converted = true;
      throw new Error("conversion attempted");
    },
  };

  await assert.rejects(() => collectProtocolEvidence([malicious]), /仅包含字符串路径/u);
  assert.equal(converted, false);
});
