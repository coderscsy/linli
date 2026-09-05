import assert from "node:assert/strict";
import test from "node:test";
import * as metadata from "../midi/song-metadata.js";
import { formatSong } from "../midi/routes.js";

const generic = { id: "work", name: "Source", videoPath: "default.mp4", videoByTodView: { DEFAULT: "default.mp4", ALT_2: "second.mp4", ALT_3: "third.mp4" } };
test("generic indices do not establish time and preserve default playback", () => {
  const description = metadata.describeSongMetadata(generic);
  assert.equal(description.mappingStatus, "unconfirmed");
  assert.deepEqual(description.mapping, { TOD12: null, TOD1730: null, TOD20: null });
  assert.equal(metadata.selectSongVariant(generic, "TOD20", "WI").path, "default.mp4");
  assert.equal(metadata.selectSongVariant(generic, "TOD20", "WI").reason, "unconfirmed");
  assert.match(description.variants[1].url, /\?variant=ALT_2$/u);
});
test("explicit time keys without views and manual bindings select actual variants", () => {
  const explicit = { ...generic, videoByTodView: { TOD12: "day.mp4", TOD1730: "sunset.mp4", TOD20: "night.mp4" } };
  assert.equal(metadata.describeSongMetadata(explicit).mappingStatus, "explicit");
  assert.equal(metadata.selectSongVariant(explicit, "TOD20", "WI").path, "night.mp4");
  const manual = { ...generic, timeOfDayMapping: { TOD12: "ALT_3", TOD1730: null, TOD20: "ALT_2" } };
  assert.equal(metadata.describeSongMetadata(manual).mappingStatus, "manual");
  assert.equal(metadata.selectSongVariant(manual, "TOD20", "NI").path, "second.mp4");
  assert.equal(metadata.selectSongVariant(manual, "TOD1730", "NI").path, "default.mp4");
});
test("one physical video stays one variant usable at every time", () => {
  const song = { ...generic, videoByTodView: {} };
  const description = metadata.describeSongMetadata(song);
  assert.equal(description.variants.length, 1);
  assert.equal(description.mappingStatus, "single");
  assert.equal(metadata.selectSongVariant(song, "TOD20", "WI").path, "default.mp4");
});

test("formatter retains playable fallback when only variant paths exist", () => {
  const song = { ...generic, videoPath: null, durationUs: 1000000 };
  const formatted = formatSong(song, { headers: { host: "localhost" } });
  assert.ok(formatted.videoUrl);
  assert.ok(formatted.videoByTodView.every(item => item.url));
  assert.match(formatted.videoUrl, /variant=DEFAULT$/u);
});
test("formatter deduplicates same time and view while selection remains stable", () => {
  const song = { ...generic, durationUs: 1000000, videoByTodView: { TOD12_NI_L: "left.mp4", TOD12_NI_R: "right.mp4" } };
  const formatted = formatSong(song, { headers: { host: "localhost" } });
  assert.equal(formatted.videoByTodView.length, 6);
  assert.equal(new Set(formatted.videoByTodView.map(item => `${item.tod}_${item.view}`)).size, 6);
  assert.match(formatted.videoByTodView[0].url, /variant=TOD12_NI_L$/u);
});
test("two named videos expose all native slots with safe missing-time and missing-view fallback", () => {
  const song = { ...generic, durationUs: 1000000, videoByTodView: { TOD12_NI: "day.mp4", TOD20_WI: "night.mp4", ALT_2: "unknown.mp4" } };
  const formatted = formatSong(song, { headers: { host: "localhost" } });
  assert.deepEqual(formatted.videoByTodView.map(item => [item.tod, item.view]), [["TOD12", "NI"], ["TOD12", "WI"], ["TOD1730", "NI"], ["TOD1730", "WI"], ["TOD20", "NI"], ["TOD20", "WI"]]);
  assert.equal(formatted.videoByTodView[2].url, formatted.videoUrl);
  assert.equal(formatted.videoByTodView[3].url, formatted.videoUrl);
  assert.match(formatted.videoByTodView[1].url, /variant=TOD12_NI$/u);
  assert.match(formatted.videoByTodView[4].url, /variant=TOD20_WI$/u);
  assert.equal(formatted.mapping.TOD1730, null);
});
