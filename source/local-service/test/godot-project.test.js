import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../../midi-renderer/godot/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, projectRoot), "utf8");
}

test("Godot MIDI renderer builds all 88 keys from A0 through C8", async () => {
  const main = await source("main.gd");

  assert.match(main, /FIRST_MIDI_NOTE\s*:=\s*21/u);
  assert.match(main, /LAST_MIDI_NOTE\s*:=\s*108/u);
  assert.match(main, /range\(FIRST_MIDI_NOTE,\s*LAST_MIDI_NOTE\s*\+\s*1\)/u);
  assert.match(main, /BLACK_PITCH_CLASSES\s*:=\s*\[1,\s*3,\s*6,\s*8,\s*10\]/u);
});

test("Godot MIDI renderer accepts deterministic movie arguments and frame time", async () => {
  const main = await source("main.gd");

  for (const argument of ["--timeline", "--output", "--width", "--height", "--fps", "--title"])
    assert.ok(main.includes(`\"${argument}\"`), `missing ${argument}`);
  assert.match(main, /frame_index\s*\*\s*1_000_000\s*\/\s*render_fps/u);
  assert.doesNotMatch(main, /Time\.get_ticks|Time\.get_unix|delta\s*\*/u);
});

test("Godot MIDI renderer contains no visible UID or project watermark", async () => {
  const files = await Promise.all([
    source("project.godot"),
    source("main.tscn"),
    source("main.gd"),
    source("timeline.gd"),
  ]);
  const combined = files.join("\n");

  assert.doesNotMatch(combined, /UID\s*:/iu);
  assert.doesNotMatch(combined, /watermark/iu);
  assert.doesNotMatch(combined, /米哈游|miHoYo|HoYoverse/iu);
});

test("Godot MIDI renderer ships a headless timeline smoke test", async () => {
  const project = await source("project.godot");
  const scene = await source("main.tscn");
  const smoke = await source("test/timeline_test.gd");

  assert.match(project, /run\/main_scene="res:\/\/main\.tscn"/u);
  assert.match(scene, /script = ExtResource\("1_main"\)/u);
  assert.match(smoke, /quit\(0\)/u);
  assert.match(smoke, /get_active_velocity\(60\)/u);
});

