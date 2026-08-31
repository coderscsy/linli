import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, opendir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { scanRendererInventory } from "../src/inventory.js";
import * as productionInventoryModule from "../src/inventory.js";
import { scanRendererInventoryForTest } from "../test-support/inventory-test-seam.js";

const marker = "ovilia_Win64_Development_15918";
const manifest = `"AppState" { "appid" "4532590" "name" "BSide: Olivia Lin" "installdir" "BSide Olivia Lin Test" "buildid" "24943426" "InstalledDepots" { "4532591" { "manifest" "3483511100282414030" "size" "3690442569" } } }`;

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "olivia-inventory-"));
  const game = join(root, "game");
  const candidate = join(root, "candidate", "wallpaper", "TPRender", "Binaries", "Win64");
  const steamAppsRoot = join(root, "steamapps");
  const version = join(game, "version.json");
  const protocol = join(game, "0.0.9.627", "plugins", "Studio", "NutLivePlayer.dll");
  const executable = join(candidate, "Olivia.exe");
  const appManifest = join(steamAppsRoot, "appmanifest_4532590.acf");

  await mkdir(join(game, "0.0.9.627", "plugins", "Studio"), { recursive: true });
  await mkdir(candidate, { recursive: true });
  await mkdir(steamAppsRoot, { recursive: true });
  await writeFile(version, `{"marker":"${marker}"}`);
  await writeFile(protocol, "LivePlayerStartNotify");
  await writeFile(executable, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  await writeFile(appManifest, manifest);
  return { root, game, candidate: join(root, "candidate"), steamAppsRoot, version, protocol, executable, appManifest };
}

test("scans only sorted roots, detects markers, and leaves fixtures unchanged", async () => {
  const fixture = await createFixture();
  const inputs = [fixture.version, fixture.protocol, fixture.executable, fixture.appManifest];
  const before = await Promise.all(inputs.map(sha256));
  try {
    const result = await scanRendererInventory({
      roots: [fixture.candidate, fixture.game],
      steamAppsRoot: fixture.steamAppsRoot,
      marker,
    });

    assert.deepEqual(result.roots, [fixture.candidate, fixture.game].sort());
    assert.deepEqual(result.candidates, [fixture.executable]);
    assert.deepEqual(result.markerHits, [fixture.version]);
    assert.equal(result.steam.appId, "4532590");
    assert.deepEqual(result.warnings, []);
  } finally {
    assert.deepEqual(await Promise.all(inputs.map(sha256)), before, "scanner must not modify fixtures");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("skips a symbolic link instead of traversing outside a supplied root", async (t) => {
  const fixture = await createFixture();
  const outside = await mkdtemp(join(tmpdir(), "olivia-inventory-outside-"));
  const link = join(fixture.game, "outside-link");
  const escapedCandidate = join(outside, "wallpaper", "TPRender", "Binaries", "Win64", "Olivia.exe");
  try {
    await mkdir(join(outside, "wallpaper", "TPRender", "Binaries", "Win64"), { recursive: true });
    await writeFile(escapedCandidate, Buffer.from([0x4d, 0x5a]));
    try {
      await symlink(outside, link, "junction");
    } catch (error) {
      t.skip(`Windows denied symbolic-link fixture: ${error.code}`);
      return;
    }

    const result = await scanRendererInventory({ roots: [fixture.game], steamAppsRoot: fixture.steamAppsRoot, marker });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.warnings.some(warning => warning.includes("skipped symbolic link")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects a root that is itself a symbolic link", async (t) => {
  const fixture = await createFixture();
  const link = join(fixture.root, "linked-root");
  try {
    try {
      await symlink(fixture.game, link, "junction");
    } catch (error) {
      t.skip(`Windows denied symbolic-link fixture: ${error.code}`);
      return;
    }
    const result = await scanRendererInventory({ roots: [link], steamAppsRoot: fixture.steamAppsRoot, marker });
    assert.deepEqual(result.markerHits, []);
    assert.ok(result.warnings.some(warning => warning.includes("skipped symbolic link")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("continues when marker reading fails and emits a stable safe warning", async () => {
  const fixture = await createFixture();
  const fsAdapter = {
    lstat,
    realpath,
    opendir,
    readFile: async (file, encoding) => {
      if (file === fixture.version) {
        const error = new Error("x-token=secret aaa.bbb.ccc");
        error.code = "x-token=secret";
        throw error;
      }
      return readFile(file, encoding);
    },
  };
  try {
    const result = await scanRendererInventoryForTest({ roots: [fixture.game], steamAppsRoot: fixture.steamAppsRoot, marker }, fsAdapter);
    assert.deepEqual(result.markerHits, []);
    assert.deepEqual(result.warnings, [...result.warnings].sort());
    assert.ok(result.warnings.some(warning => warning === "scan: access_error"));
    assert.doesNotMatch(result.warnings.join("\n"), /secret|aaa\.bbb\.ccc/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("drops marker data when an injected adapter reports a post-read file replacement", async () => {
  const fixture = await createFixture();
  let versionRealpathCalls = 0;
  const fsAdapter = {
    lstat,
    opendir,
    readFile,
    realpath: async file => {
      if (file === fixture.version && ++versionRealpathCalls > 3) return join(fixture.root, "outside", "version.json");
      return realpath(file);
    },
  };
  try {
    const result = await scanRendererInventoryForTest({ roots: [fixture.game], steamAppsRoot: fixture.steamAppsRoot, marker }, fsAdapter);
    assert.deepEqual(result.markerHits, []);
    assert.ok(result.warnings.some(warning => warning.includes("changed during read")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("drops a candidate when an injected adapter reports a directory replacement", async () => {
  const fixture = await createFixture();
  const rendererDirectory = join(fixture.root, "candidate", "wallpaper", "TPRender");
  let rendererRealpathCalls = 0;
  const fsAdapter = {
    lstat,
    opendir,
    readFile,
    realpath: async file => {
      if (file === rendererDirectory && ++rendererRealpathCalls > 1) return join(fixture.root, "outside", "TPRender");
      return realpath(file);
    },
  };
  try {
    const result = await scanRendererInventoryForTest({ roots: [fixture.candidate], steamAppsRoot: fixture.steamAppsRoot, marker }, fsAdapter);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.warnings.some(warning => warning.includes("outside root") || warning.includes("changed")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production inventory API ignores an injected filesystem adapter", async () => {
  const fixture = await createFixture();
  const hostileAdapter = {
    lstat: async () => { throw new Error("adapter must not be called"); },
    realpath: async () => { throw new Error("adapter must not be called"); },
    opendir: async () => { throw new Error("adapter must not be called"); },
    readFile: async () => { throw new Error("adapter must not be called"); },
  };
  try {
    const result = await scanRendererInventory({
      roots: [fixture.game],
      steamAppsRoot: fixture.steamAppsRoot,
      marker,
      fsAdapter: hostileAdapter,
    });
    assert.deepEqual(result.markerHits, [fixture.version]);
    assert.equal(result.steam.appId, "4532590");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production inventory module exposes no adapter or test seam", () => {
  assert.deepEqual(Object.keys(productionInventoryModule).sort(), ["scanRendererInventory"]);
});
