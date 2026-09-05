import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPlayerUploadManifest } from "../midi/catalog-manifest.js";

test("player upload manifest leaves unverified positional catalog entries unnamed", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-player-library-"));
  const musicRoot = join(root, "music");
  const catalogRoot = join(root, "catalog");
  try {
    const groupRoot = join(musicRoot, "原神3", "米哈游 原神3");
    const first = join(groupRoot, "midi_100_1");
    const second = join(groupRoot, "midi_200_2");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(join(first, "a.mp4"), "a");
    await writeFile(join(first, "b.mp4"), "b");
    await writeFile(join(second, "c.mp4"), "c");
    await writeFile(join(catalogRoot, "原神3.txt"), [
      "ABC123 —— 第一首",
      "BAD001 —— 已失效歌曲 提示已使用",
    ].join("\n"));

    const manifest = await buildPlayerUploadManifest({ musicRoot, catalogRoot });

    assert.equal(manifest.performanceCount, 2);
    assert.equal(manifest.videoCount, 3);
    assert.equal(manifest.namedCount, 0);
    assert.equal(manifest.fallbackCount, 2);
    assert.deepEqual(manifest.songs.map(song => song.name), [
      "原神3 · midi_100_1",
      "原神3 · midi_200_2",
    ]);
    assert.deepEqual(manifest.songs[0].variants, {
      DEFAULT: "原神3/米哈游 原神3/midi_100_1/a.mp4",
      ALT_2: "原神3/米哈游 原神3/midi_100_1/b.mp4",
    });
    assert.match(manifest.warnings.join("\n"), /1 条曲目尚未建立已验证的目录绑定/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("player upload manifest uses explicit share-code bindings instead of directory order", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-player-library-order-"));
  const musicRoot = join(root, "music");
  const catalogRoot = join(root, "catalog");
  try {
    const groupRoot = join(musicRoot, "其他", "米哈游 其他");
    const createdFirst = join(groupRoot, "midi_900_100");
    const createdSecond = join(groupRoot, "midi_100_200");
    await mkdir(createdFirst, { recursive: true });
    await mkdir(createdSecond, { recursive: true });
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(join(createdFirst, "first.mp4"), "first");
    await writeFile(join(createdSecond, "second.mp4"), "second");
    await writeFile(join(catalogRoot, "其他.txt"), [
      "FIRST1 —— 第一首",
      "SECOND2 —— 第二首",
    ].join("\n"));
    await writeFile(join(catalogRoot, "catalog-bindings.json"), JSON.stringify({
      version: 1,
      groups: {
        其他: {
          FIRST1: "midi_100_200",
          SECOND2: "midi_900_100",
        },
      },
    }));

    const manifest = await buildPlayerUploadManifest({ musicRoot, catalogRoot });

    const byName = new Map(manifest.songs.map(song => [song.name, song]));
    assert.equal(byName.get("第一首【其他 · FIRST1】").variants.DEFAULT, "其他/米哈游 其他/midi_100_200/second.mp4");
    assert.equal(byName.get("第二首【其他 · SECOND2】").variants.DEFAULT, "其他/米哈游 其他/midi_900_100/first.mp4");
    assert.equal(manifest.namedCount, 2);
    assert.equal(manifest.fallbackCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
