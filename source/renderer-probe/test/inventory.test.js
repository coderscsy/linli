import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { scanRendererInventory } from "../src/inventory.js";

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
    assert.ok(result.warnings.some(warning => warning.includes(relative(fixture.game, link)) || warning.includes("outside-link")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
