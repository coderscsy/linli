import test from "node:test";
import assert from "node:assert/strict";
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
    assert.deepEqual(evidence.files.map(file => file.path), [earlier, later]);
    assert.deepEqual(evidence.messages, [
      { encoding: "ascii", file: earlier, offset: 0, value: "LivePlayerReply" },
    ]);
    assert.deepEqual(evidence.paths, [
      { encoding: "ascii", file: later, offset: 16, value: "C:\\wallpaper\\TPRender\\schema.proto" },
    ]);
    assert.equal(evidence.files[0].matches.length, 1);
    assert.match(evidence.files[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(evidence.files[0].size, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol evidence removes credential fragments while preserving the protocol marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const file = join(root, "NutLivePlayer.dll");
    const credential = ["aaa", "bbb", "ccc"].join(".");
    await writeFile(file, `Cmd.LivePlayerCtrlNotify.event_name x-token=${credential}`);

    const evidence = await collectProtocolEvidence([file]);
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /x-token|aaa\.bbb\.ccc/u);
    assert.match(serialized, /LivePlayerCtrlNotify/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns deterministic safe read errors without exposing filesystem error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const unavailable = join(root, "missing.dll");
    const evidence = await collectProtocolEvidence([unavailable]);

    assert.deepEqual(evidence, {
      files: [{ error: "read_failed", path: unavailable }],
      markers: [],
      messages: [],
      paths: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
