import test from "node:test";
import assert from "node:assert/strict";
import { assertContained, resolveProbeLayout } from "../src/layout.js";

test("default runtime layout stays on I drive", () => {
  const layout = resolveProbeLayout("I:\\OliviaSoulData\\MidiRenderer");
  assert.equal(layout.root, "I:\\OliviaSoulData\\MidiRenderer");
  assert.equal(layout.reportJson, "I:\\OliviaSoulData\\MidiRenderer\\evidence\\stage1a-report.json");
});

test("production layout rejects a C drive root", () => {
  assert.throws(() => resolveProbeLayout("C:\\temp\\MidiRenderer"), /必须位于 I 盘/u);
});

test("production layout accepts only the fixed root or its subdirectories", () => {
  assert.equal(
    resolveProbeLayout("I:\\OliviaSoulData\\MidiRenderer\\run-1").root,
    "I:\\OliviaSoulData\\MidiRenderer\\run-1",
  );
  for (const path of [
    "I:\\OliviaSoulData\\Other",
    "I:\\OliviaSoulData\\MidiRenderer-Evil",
    "I:\\OliviaSoulData",
    "C:\\OliviaSoulData\\MidiRenderer",
  ]) {
    assert.throws(() => resolveProbeLayout(path));
  }
});

test("containment rejects path traversal", () => {
  assert.throws(
    () => assertContained("I:\\OliviaSoulData\\MidiRenderer", "I:\\OliviaSoulData\\outside.json"),
    /越过根目录/u,
  );
});
