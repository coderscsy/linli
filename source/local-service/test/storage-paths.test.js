import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMigrationCapacity,
  parseSongStoragePath,
  resolveSongStoragePath,
  storageDirectories,
} from "../storage-paths.js";

test("从 usersettings.dat 只读解析 songStoragePath", () => {
  const settings = Buffer.from("\u0000prefix\u0000songStoragePath\u0000\"D:\\\\Music Library\"\u0000suffix", "utf8");
  assert.equal(parseSongStoragePath(settings), "D:\\Music Library");
});

test("解析游戏二进制帧中的 songStoragePath 控制字节", () => {
  const settings = Buffer.concat([
    Buffer.from([0xd8, 0x00, 0x01, 0x0f]),
    Buffer.from("songStoragePath", "utf8"),
    Buffer.from([0x10, 0x10]),
    Buffer.from('"I:\\\\Music"', "utf8"),
    Buffer.from([0x11]),
  ]);
  assert.equal(parseSongStoragePath(settings), "I:\\Music");
});

test("设置文件暂时被占用时重试并使用游戏路径", async () => {
  let attempts = 0;
  const result = await resolveSongStoragePath({
    settingsPath: "C:\\Game\\usersettings.dat",
    retryCount: 3,
    retryDelayMs: 0,
    readFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return Buffer.from("songStoragePath\u0000\"D:\\\\Music\"");
    },
    accessImpl: async path => assert.equal(path, "D:\\Music"),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result, {
    configuredPath: "D:\\Music",
    activePath: "D:\\Music",
    source: "game-settings",
    state: "ready",
    error: null,
  });
});

test("新路径不可访问时保留最后一次有效路径", async () => {
  const result = await resolveSongStoragePath({
    settingsPath: "C:\\Game\\usersettings.dat",
    lastValidPath: "E:\\Last Valid",
    retryCount: 1,
    readFileImpl: async () => Buffer.from("songStoragePath\u0000\"D:\\\\Unavailable\""),
    accessImpl: async path => {
      if (path === "D:\\Unavailable") throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });

  assert.equal(result.configuredPath, "D:\\Unavailable");
  assert.equal(result.activePath, "E:\\Last Valid");
  assert.equal(result.source, "last-valid");
  assert.equal(result.state, "unavailable");
  assert.match(result.error, /游戏设置的曲目路径不可访问/u);
});

test("统一派生官方作品、视频回信与 staging 目录", () => {
  const directories = storageDirectories("D:\\Music");
  assert.equal(directories.root, "D:\\Music\\OliviaSoul");
  assert.equal(directories.performances, "D:\\Music\\OliviaSoul\\我的上传");
  assert.equal(directories.videoReplies, "D:\\Music\\OliviaSoul\\视频回信");
  assert.equal(directories.staging, "D:\\Music\\OliviaSoul\\.staging");
});

test("迁移空间预留 512 MiB 或待复制大小的 5%", () => {
  const gib = 1024 ** 3;
  const enough = checkMigrationCapacity({ requiredBytes: 2 * gib, freeBytes: 3 * gib });
  assert.equal(enough.reserveBytes, 512 * 1024 ** 2);
  assert.equal(enough.totalRequiredBytes, 2.5 * gib);
  assert.equal(enough.sufficient, true);

  const large = checkMigrationCapacity({ requiredBytes: 20 * gib, freeBytes: 20.5 * gib });
  assert.equal(large.reserveBytes, gib);
  assert.equal(large.totalRequiredBytes, 21 * gib);
  assert.equal(large.sufficient, false);
  assert.equal(large.shortfallBytes, 0.5 * gib);
});
