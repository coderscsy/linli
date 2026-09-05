import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalogRelinkPlan } from "../midi/catalog-relink.js";

test("catalog relink keeps song ids and binds each title to its performance directory", () => {
  const musicRoot = "I:\\library";
  const rows = [
    { id: "song-a", name: "错误标题 A", video_path: "external:I:\\library\\group\\midi_2_200\\a.mp4" },
    { id: "song-b", name: "错误标题 B", video_path: "external:I:\\library\\group\\midi_1_100\\b.mp4" },
  ];
  const songs = [
    { name: "正确标题 B", variants: { DEFAULT: "group/midi_1_100/b.mp4" } },
    { name: "正确标题 A", variants: { DEFAULT: "group/midi_2_200/a.mp4" } },
  ];

  const plan = buildCatalogRelinkPlan({ rows, songs, musicRoot });

  assert.deepEqual(plan.unmatchedRows, []);
  assert.deepEqual(plan.unmatchedManifest, []);
  assert.deepEqual(plan.updates, [
    { id: "song-a", before: "错误标题 A", after: "正确标题 A" },
    { id: "song-b", before: "错误标题 B", after: "正确标题 B" },
  ]);
});
