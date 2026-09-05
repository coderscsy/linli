import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { readClientPatchRegistry, registerMountedClientPatch } from "../desktop/client-patch-registry.js";
import { canonicalProcessRoot, restoreAllClientPatches } from "../desktop/uninstall-restore.js";

async function rootFixture() {
  const tempRoot = resolve(tmpdir());
  const root = await mkdtemp(join(tempRoot, "uninstall-restore-"));
  after(async () => {
    const target = resolve(root);
    if (dirname(target) !== tempRoot || !/^uninstall-restore-[A-Za-z0-9]+$/u.test(basename(target)))
      throw new Error("unsafe fixture cleanup target");
    await rm(target, { recursive: true, force: true });
  });
  const userData = join(root, "UserData");
  await mkdir(userData, { recursive: true });
  return { root, userData };
}

async function addClient(f, name, optional = false) {
  const clientRoot = join(f.root, name), version = "9.8.7";
  const backupRoot = join(f.userData, "database", "client-backups", "resources-only", name);
  await mkdir(join(clientRoot, version, "resources"), { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const specs = [["feapp", join(version, "resources", "feapp.dat")], ["webplayer", join(version, "resources", "webplayer.dat")]];
  if (optional) specs.push(["studioUi", join(version, "plugins", "Studio", "NutStudioUI.dll")]);
  const files = [];
  for (const [kind, relative] of specs) {
    const target = join(clientRoot, relative), backup = join(backupRoot, `${kind}.original`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(backup, `${name}-${kind}-original`);
    await writeFile(target, `${name}-${kind}-patched`);
    files.push({ kind, target, backup });
  }
  await registerMountedClientPatch({ userData: f.userData, clientRoot, version, files });
  return { clientRoot, version, files };
}

const stopped = async () => {};

test("protected-process root canonicalization creates exactly one boundary separator for drive roots", () => {
  assert.equal(canonicalProcessRoot("D:\\"), "D:");
  assert.equal(`${canonicalProcessRoot("D:\\")}\\`, "D:\\");
  assert.equal(canonicalProcessRoot("D:\\Games\\Olivia\\"), "D:\\Games\\Olivia");
});

function nativeDllBytes() {
  const patch = Buffer.from([0x33, 0xc0, 0x90, 0x90, 0x90, 0x90]);
  const studioPatterns = [
    "cbe8d2370800eb1eff15b2ec0800488d8fa8", "cbe872340800eb1eff1552e90800488d8fa8",
    "cbe8b21f0800eb2bff1592d4080084c07514", "cbe8ff1d0800eb1cff15dfd20800488d4f38",
  ].map(value => Buffer.from(value, "hex"));
  const studioOriginal = Buffer.concat(studioPatterns), studioPatched = Buffer.from(studioOriginal);
  for (const pattern of studioPatterns) patch.copy(studioPatched, studioOriginal.indexOf(pattern) + 8);
  const containerPattern = Buffer.from("488bda488bf9ff1561a4040084c00f85", "hex");
  const containerOriginal = Buffer.concat([Buffer.from("before"), containerPattern, Buffer.from("after")]);
  const containerPatched = Buffer.from(containerOriginal);
  patch.copy(containerPatched, containerOriginal.indexOf(containerPattern) + 6);
  return { studioOriginal, studioPatched, containerOriginal, containerPatched };
}

test("legacy adoption restores only the settings-selected unique mounted client from its exact staged pair", async () => {
  const f = await rootFixture();
  const clientRoot = join(f.root, "selected-game"), version = "3.2.1";
  const clientExe = join(clientRoot, "Olivia.exe");
  const targets = {
    feapp: join(clientRoot, version, "resources", "feapp.dat"),
    webplayer: join(clientRoot, version, "resources", "webplayer.dat"),
  };
  await mkdir(dirname(targets.feapp), { recursive: true });
  await writeFile(clientExe, "fixture exe");
  await writeFile(targets.feapp, "selected-fe-patched");
  await writeFile(targets.webplayer, "selected-wp-patched");
  await writeFile(join(f.userData, "desktop-settings.json"), JSON.stringify({ port: 27149, clientExe }));
  const key = createHash("md5").update(`${clientRoot.toLowerCase()}\n${version.toLowerCase()}`).digest("hex");
  const stage = join(f.userData, "database", "client-backups", "resources-only", key);
  await mkdir(stage, { recursive: true });
  const backups = {
    feapp: join(stage, `${key}.feapp.dat`),
    webplayer: join(stage, `${key}.webplayer.dat`),
  };
  await writeFile(backups.feapp, "selected-fe-original");
  await writeFile(backups.webplayer, "selected-wp-original");
  const unrelated = join(f.root, "old-unselected", "9.9.9", "resources", "feapp.dat");
  await mkdir(dirname(unrelated), { recursive: true });
  await writeFile(unrelated, "old-client-patched");
  let guardedRoots;
  const result = await restoreAllClientPatches({
    userData: f.userData,
    assertProtectedProcessesStopped: async roots => { guardedRoots = roots; },
    readLegacyPatchStatus: async (_kind, path) => path === targets.feapp || path === targets.webplayer
      ? { clientFound: true, mounted: true, managed: true, updateAvailable: false }
      : { clientFound: true, mounted: false, managed: false, updateAvailable: false },
    validateLegacyArchivePair: async () => true,
  });
  assert.deepEqual(guardedRoots, [clientRoot]);
  assert.deepEqual(result, { restoredClients: 1, restoredFiles: 2, steamRestored: false });
  assert.equal(await readFile(targets.feapp, "utf8"), "selected-fe-original");
  assert.equal(await readFile(targets.webplayer, "utf8"), "selected-wp-original");
  assert.equal(await readFile(unrelated, "utf8"), "old-client-patched");
  assert.equal((await readClientPatchRegistry({ userData: f.userData })).clients[0].state, "restored");
});

test("legacy adoption includes only optional DLL sidecars whose live bytes prove the exact Olivia transform", async () => {
  const f = await rootFixture(), clientRoot = join(f.root, "legacy-native"), version = "3.2.1";
  const clientExe = join(clientRoot, "Olivia.exe"), resources = join(clientRoot, version, "resources");
  const studioTarget = join(clientRoot, version, "plugins", "Studio", "NutStudioUI.dll");
  const containerTarget = join(clientRoot, version, "plugins", "Container", "NutContainerPlugin.dll");
  await Promise.all([mkdir(resources, { recursive: true }), mkdir(dirname(studioTarget), { recursive: true }), mkdir(dirname(containerTarget), { recursive: true })]);
  await Promise.all([writeFile(clientExe, "fixture exe"), writeFile(join(resources, "feapp.dat"), "patched-fe"), writeFile(join(resources, "webplayer.dat"), "patched-wp")]);
  await writeFile(join(f.userData, "desktop-settings.json"), JSON.stringify({ port: 27149, clientExe }));
  const key = createHash("md5").update(`${clientRoot.toLowerCase()}\n${version.toLowerCase()}`).digest("hex");
  const stage = join(f.userData, "database", "client-backups", "resources-only", key);
  const legacySidecars = join(f.userData, "client-backups");
  await Promise.all([mkdir(stage, { recursive: true }), mkdir(legacySidecars, { recursive: true })]);
  const bytes = nativeDllBytes();
  await Promise.all([
    writeFile(join(stage, `${key}.feapp.dat`), "original-fe"), writeFile(join(stage, `${key}.webplayer.dat`), "original-wp"),
    writeFile(join(legacySidecars, `NutStudioUI-${version}.dll`), bytes.studioOriginal), writeFile(studioTarget, bytes.studioPatched),
    writeFile(join(legacySidecars, `NutContainerPlugin-${version}.dll`), bytes.containerOriginal), writeFile(containerTarget, bytes.containerPatched),
  ]);

  await assert.rejects(restoreAllClientPatches({
    userData: f.userData,
    assertProtectedProcessesStopped: async () => { throw new Error("GAME_RUNNING"); },
    readLegacyPatchStatus: async (_kind, path) => path.startsWith(resources)
      ? { clientFound: true, mounted: true, managed: true, updateAvailable: false }
      : { clientFound: true, mounted: false, managed: false, updateAvailable: false },
    validateLegacyArchivePair: async () => true,
  }), /GAME_RUNNING/u);
  await assert.rejects(readFile(join(stage, `NutStudioUI-${version}.dll`)), { code: "ENOENT" });
  await assert.rejects(readFile(join(stage, `NutContainerPlugin-${version}.dll`)), { code: "ENOENT" });

  const stagedFeBackup = join(stage, `${key}.feapp.dat`);
  await assert.rejects(restoreAllClientPatches({
    userData: f.userData,
    assertProtectedProcessesStopped: async () => { await rm(stagedFeBackup); },
    readLegacyPatchStatus: async (_kind, path) => path.startsWith(resources)
      ? { clientFound: true, mounted: true, managed: true, updateAvailable: false }
      : { clientFound: true, mounted: false, managed: false, updateAvailable: false },
    validateLegacyArchivePair: async () => true,
  }), /backup|missing|inaccessible|ENOENT/i);
  await assert.rejects(readFile(join(stage, `NutStudioUI-${version}.dll`)), { code: "ENOENT" });
  await assert.rejects(readFile(join(stage, `NutContainerPlugin-${version}.dll`)), { code: "ENOENT" });
  await writeFile(stagedFeBackup, "original-fe");

  const legacyContainerBackup = join(legacySidecars, `NutContainerPlugin-${version}.dll`);
  await assert.rejects(restoreAllClientPatches({
    userData: f.userData,
    assertProtectedProcessesStopped: async () => { await rm(legacyContainerBackup); },
    readLegacyPatchStatus: async (_kind, path) => path.startsWith(resources)
      ? { clientFound: true, mounted: true, managed: true, updateAvailable: false }
      : { clientFound: true, mounted: false, managed: false, updateAvailable: false },
    validateLegacyArchivePair: async () => true,
  }), /source|target|changed|backup|native/i);
  await assert.rejects(readFile(join(stage, `NutStudioUI-${version}.dll`)), { code: "ENOENT" });
  await assert.rejects(readFile(join(stage, `NutContainerPlugin-${version}.dll`)), { code: "ENOENT" });
  await writeFile(legacyContainerBackup, bytes.containerOriginal);

  const result = await restoreAllClientPatches({
    userData: f.userData, assertProtectedProcessesStopped: stopped,
    readLegacyPatchStatus: async (_kind, path) => path.startsWith(resources)
      ? { clientFound: true, mounted: true, managed: true, updateAvailable: false }
      : { clientFound: true, mounted: false, managed: false, updateAvailable: false },
    validateLegacyArchivePair: async () => true,
  });

  assert.deepEqual(result, { restoredClients: 1, restoredFiles: 4, steamRestored: false });
  assert.equal((await readFile(studioTarget)).equals(bytes.studioOriginal), true);
  assert.equal((await readFile(containerTarget)).equals(bytes.containerOriginal), true);
  assert.equal((await readFile(join(stage, `NutStudioUI-${version}.dll`))).equals(bytes.studioOriginal), true);
  assert.equal((await readFile(join(stage, `NutContainerPlugin-${version}.dll`))).equals(bytes.containerOriginal), true);
  const [record] = (await readClientPatchRegistry({ userData: f.userData })).clients;
  assert.deepEqual(record.files.map(file => file.kind), ["feapp", "webplayer", "studioUi", "containerPlugin"]);
});

test("legacy adoption refuses an optional DLL sidecar whose target is not the exact Olivia transform", async () => {
  const f = await rootFixture(), clientRoot = join(f.root, "legacy-native-invalid"), version = "3.2.1";
  const clientExe = join(clientRoot, "Olivia.exe"), resources = join(clientRoot, version, "resources");
  const studioTarget = join(clientRoot, version, "plugins", "Studio", "NutStudioUI.dll");
  await Promise.all([mkdir(resources, { recursive: true }), mkdir(dirname(studioTarget), { recursive: true })]);
  await Promise.all([writeFile(clientExe, "fixture exe"), writeFile(join(resources, "feapp.dat"), "patched-fe"), writeFile(join(resources, "webplayer.dat"), "patched-wp")]);
  await writeFile(join(f.userData, "desktop-settings.json"), JSON.stringify({ port: 27149, clientExe }));
  const key = createHash("md5").update(`${clientRoot.toLowerCase()}\n${version.toLowerCase()}`).digest("hex");
  const stage = join(f.userData, "database", "client-backups", "resources-only", key);
  await mkdir(stage, { recursive: true });
  const bytes = nativeDllBytes();
  await Promise.all([
    writeFile(join(stage, `${key}.feapp.dat`), "original-fe"), writeFile(join(stage, `${key}.webplayer.dat`), "original-wp"),
    writeFile(join(stage, `NutStudioUI-${version}.dll`), bytes.studioOriginal), writeFile(studioTarget, "user-modified-native-file"),
  ]);

  await assert.rejects(restoreAllClientPatches({
    userData: f.userData, assertProtectedProcessesStopped: stopped,
    readLegacyPatchStatus: async (_kind, path) => path.startsWith(resources)
      ? { clientFound: true, mounted: true, managed: true, updateAvailable: false }
      : { clientFound: true, mounted: false, managed: false, updateAvailable: false },
    validateLegacyArchivePair: async () => true,
  }), /verified|transform|optional/u);
  assert.equal(await readFile(join(resources, "feapp.dat"), "utf8"), "patched-fe");
  await assert.rejects(readFile(join(f.userData, "settings", "client-patches.json")), { code: "ENOENT" });
});

for (const [name, mutate] of [
  ["ambiguous client versions", async ({ clientRoot }) => {
    const extra = join(clientRoot, "4.0.0", "resources"); await mkdir(extra, { recursive: true });
    await writeFile(join(extra, "feapp.dat"), "x"); await writeFile(join(extra, "webplayer.dat"), "y");
  }],
  ["missing exact staged pair", async ({ stage, key }) => rm(join(stage, `${key}.webplayer.dat`))],
]) test(`legacy adoption rejects ${name} without scanning other client paths`, async () => {
  const f = await rootFixture(), clientRoot = join(f.root, "selected"), version = "1.0";
  const clientExe = join(clientRoot, "Olivia.exe"), resources = join(clientRoot, version, "resources");
  await mkdir(resources, { recursive: true }); await writeFile(clientExe, "exe");
  await writeFile(join(resources, "feapp.dat"), "patched-fe"); await writeFile(join(resources, "webplayer.dat"), "patched-wp");
  await writeFile(join(f.userData, "desktop-settings.json"), JSON.stringify({ port: 27149, clientExe }));
  const key = createHash("md5").update(`${clientRoot.toLowerCase()}\n${version}`).digest("hex");
  const stage = join(f.userData, "database", "client-backups", "resources-only", key);
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, `${key}.feapp.dat`), "original-fe"); await writeFile(join(stage, `${key}.webplayer.dat`), "original-wp");
  await mutate({ clientRoot, stage, key });
  await assert.rejects(restoreAllClientPatches({
    userData: f.userData, assertProtectedProcessesStopped: stopped,
    readLegacyPatchStatus: async () => ({ clientFound: true, mounted: true, managed: true, updateAvailable: false }),
    validateLegacyArchivePair: async () => true,
  }), /unique|version|staged|pair|missing/u);
});

test("no registry succeeds without modifying UserData", async () => {
  const f = await rootFixture();
  const sentinel = join(f.userData, "sentinel.txt");
  await writeFile(sentinel, "keep");
  assert.deepEqual(await restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), { restoredClients: 0, restoredFiles: 0, steamRestored: false });
  assert.equal(await readFile(sentinel, "utf8"), "keep");
});

test("all clients and registered optional DLLs restore, preserve usersettings, and retry idempotently", async () => {
  const f = await rootFixture();
  const first = await addClient(f, "first", true);
  const second = await addClient(f, "second");
  const usersettings = join(f.userData, "usersettings.dat");
  await writeFile(usersettings, "never overwrite");
  const result = await restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped });
  assert.deepEqual(result, { restoredClients: 2, restoredFiles: 5, steamRestored: false });
  for (const file of [...first.files, ...second.files]) assert.deepEqual(await readFile(file.target), await readFile(file.backup));
  assert.equal(await readFile(usersettings, "utf8"), "never overwrite");
  assert.ok((await readClientPatchRegistry({ userData: f.userData })).clients.every(client => client.state === "restored"));
  assert.deepEqual(await restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), { restoredClients: 0, restoredFiles: 0, steamRestored: false });
});

for (const [name, corrupt] of [
  ["missing backup", async file => rm(file.backup)],
  ["patched backup", async file => writeFile(file.backup, "/*OliviaSoulPatch:bad*/")],
  ["backup hash mismatch", async file => writeFile(file.backup, "different clean backup")],
  ["user-modified target", async file => writeFile(file.target, "user modification")],
  ["inaccessible target", async file => rm(file.target)],
]) test(`full preflight stops before the first write for ${name}`, async () => {
  const f = await rootFixture();
  const first = await addClient(f, "first");
  const second = await addClient(f, "second");
  const before = await readFile(first.files[0].target);
  await corrupt(second.files[1]);
  await assert.rejects(restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), /backup|hash|modified|target|accessible|ENOENT/i);
  assert.deepEqual(await readFile(first.files[0].target), before);
});

test("running game or Steam guard fails before any target write and is never asked to kill a process", async () => {
  const f = await rootFixture();
  const client = await addClient(f, "first");
  const before = await readFile(client.files[0].target);
  let calls = 0;
  await assert.rejects(restoreAllClientPatches({
    userData: f.userData,
    assertProtectedProcessesStopped: async roots => { calls++; assert.deepEqual(roots, [client.clientRoot]); throw new Error("PROTECTED_PROCESS_RUNNING"); },
  }), /PROTECTED_PROCESS_RUNNING/u);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(client.files[0].target), before);
});

test("a second-file write failure rolls back the current client and leaves every file retryable active", async () => {
  const f = await rootFixture();
  const client = await addClient(f, "first");
  const patched = await Promise.all(client.files.map(file => readFile(file.target)));
  let calls = 0;
  await assert.rejects(restoreAllClientPatches({
    userData: f.userData,
    assertProtectedProcessesStopped: stopped,
    replaceFile: async (path, bytes) => {
      calls++;
      if (calls === 2) throw new Error("INJECTED_SECOND_REPLACE_FAILURE");
      await writeFile(path, bytes);
    },
  }), /INJECTED_SECOND_REPLACE_FAILURE/u);
  assert.deepEqual(await Promise.all(client.files.map(file => readFile(file.target))), patched);
  const record = (await readClientPatchRegistry({ userData: f.userData })).clients[0];
  assert.equal(record.state, "active");
  assert.ok(record.files.every(file => file.state === "active"));
});

test("ambiguous Steam manifests fail before client writes while a unique exact installedOptions match restores", async () => {
  const f = await rootFixture();
  const client = await addClient(f, "first");
  const before = await readFile(client.files[0].target);
  const steam = join(f.userData, "Backups", "steam-launcher");
  const configPath = join(f.root, "Steam", "userdata", "7", "config", "localconfig.vdf");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(join(f.root, "Steam", "steam.exe"), "fixture");
  const installed = '"helper.exe" %command%';
  const original = "-windowed";
  const vdf = options => `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "4532590" { "LaunchOptions" "${options.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" } } } } } }`;
  await writeFile(configPath, vdf(installed));
  await mkdir(steam, { recursive: true });
  const manifest = { version: 1, configPath, appId: "4532590", originalOptions: original, installedOptions: installed, originalHash: "0".repeat(64), backupPath: join(steam, "original.vdf"), mode: "install" };
  const originalBytes = Buffer.from(vdf(original));
  manifest.originalHash = (await import("node:crypto")).createHash("sha256").update(originalBytes).digest("hex");
  await writeFile(manifest.backupPath, originalBytes);
  await writeFile(join(steam, "one.json"), JSON.stringify(manifest));
  await writeFile(join(steam, "two.json"), JSON.stringify(manifest));
  await assert.rejects(restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), /STEAM_MANIFEST_CONFLICT/u);
  assert.deepEqual(await readFile(client.files[0].target), before);
  await rm(join(steam, "two.json"));
  const changedConfig = join(f.root, "Steam", "userdata", "8", "config", "localconfig.vdf");
  const changedBackup = join(steam, "changed-original.vdf");
  const changedOriginal = Buffer.from(vdf(original));
  await mkdir(dirname(changedConfig), { recursive: true });
  await writeFile(changedConfig, vdf("-user-changed"));
  await writeFile(changedBackup, changedOriginal);
  await writeFile(join(steam, "changed.json"), JSON.stringify({
    ...manifest, configPath: changedConfig, backupPath: changedBackup,
    originalHash: createHash("sha256").update(changedOriginal).digest("hex"),
  }));
  await assert.rejects(restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), /STEAM_OPTIONS_CHANGED/u);
  assert.deepEqual(await readFile(client.files[0].target), before);
  await rm(join(steam, "changed.json"));
  await writeFile(configPath, vdf("-user-changed"));
  await assert.rejects(restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), /STEAM_OPTIONS_CHANGED/u);
  assert.deepEqual(await readFile(client.files[0].target), before);
  await writeFile(configPath, vdf(installed));
  await writeFile(join(steam, "historical-restore.json"), JSON.stringify({ ...manifest, mode: "restore" }));
  const result = await restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped });
  assert.equal(result.steamRestored, true);
  assert.match(await readFile(configPath, "utf8"), /LaunchOptions"\s+"-windowed"/u);
});

test("Steam preflight rejects a config path whose userdata ancestor is a junction outside its canonical Steam root", async () => {
  const f = await rootFixture();
  const steamBackups = join(f.userData, "Backups", "steam-launcher");
  const steamRoot = join(f.root, "Steam"), escapedUserdata = join(f.root, "escaped-userdata");
  const configPath = join(steamRoot, "userdata", "7", "config", "localconfig.vdf");
  const installed = '"helper.exe" %command%', original = "-windowed";
  const vdf = options => `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "4532590" { "LaunchOptions" "${options.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" } } } } } }`;
  await Promise.all([
    mkdir(steamRoot, { recursive: true }), mkdir(join(escapedUserdata, "7", "config"), { recursive: true }),
    mkdir(steamBackups, { recursive: true }),
  ]);
  await writeFile(join(steamRoot, "steam.exe"), "fixture");
  await symlink(escapedUserdata, join(steamRoot, "userdata"), "junction");
  await writeFile(configPath, vdf(installed));
  const backupPath = join(steamBackups, "original.vdf"), backup = Buffer.from(vdf(original));
  await writeFile(backupPath, backup);
  await writeFile(join(steamBackups, "one.json"), JSON.stringify({
    version: 1, configPath, appId: "4532590", originalOptions: original, installedOptions: installed,
    originalHash: createHash("sha256").update(backup).digest("hex"), backupPath, mode: "install",
  }));

  await assert.rejects(restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), /Steam|path|reparse|junction|canonical/i);
  assert.equal(await readFile(configPath, "utf8"), vdf(installed));
});

test("packaged Steam editor is resolved from resources workspace-template before source fallbacks", async () => {
  const f = await rootFixture();
  const steam = join(f.userData, "Backups", "steam-launcher");
  const configPath = join(f.root, "Steam", "userdata", "7", "config", "localconfig.vdf");
  const bundle = join(f.root, "resources", "workspace-template", "tools", "steam-launcher", "steam-launch-options.mjs");
  await mkdir(dirname(configPath), { recursive: true }); await mkdir(steam, { recursive: true }); await mkdir(dirname(bundle), { recursive: true });
  await writeFile(configPath, '"UserLocalConfigStore" {}');
  const backupPath = join(steam, "original.vdf"), backup = Buffer.from("backup"); await writeFile(backupPath, backup);
  await writeFile(join(steam, "one.json"), JSON.stringify({
    version: 1, configPath, appId: "4532590", originalOptions: null, installedOptions: '"helper" %command%',
    originalHash: createHash("sha256").update(backup).digest("hex"), backupPath, mode: "install",
  }));
  await writeFile(bundle, 'throw new Error("BUNDLED_EDITOR_USED")');
  const untrusted = join(f.userData, "tools", "steam-launcher", "steam-launch-options.mjs");
  await mkdir(dirname(untrusted), { recursive: true });
  await writeFile(untrusted, 'throw new Error("UNTRUSTED_USERDATA_EDITOR")');
  await assert.rejects(restoreAllClientPatches({ userData: f.userData, assertProtectedProcessesStopped: stopped }), /BUNDLED_EDITOR_USED/u);
});

test("uninstall result reports stable actionable codes without leaking registry details", async () => {
  const module = await import("../desktop/uninstall-restore.js");
  const cases = [
    ["GAME_RUNNING", "GAME_RUNNING"],
    ["STEAM_RUNNING", "STEAM_RUNNING"],
    ["registered backup hash mismatch secret-token", "BACKUP_INVALID"],
    ["registered path escapes through a reparse point C:\\private", "PATH_INVALID"],
    ["registered target was user-modified or is in an unexpected state", "TARGET_CHANGED"],
  ];
  for (const [message, code] of cases) {
    const result = module.classifyRestoreError(new Error(message));
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes("secret-token"));
    assert.ok(!JSON.stringify(result).includes("C:\\private"));
  }
  const f = await rootFixture(), resultFile = join(f.root, "restore-result.json");
  await module.writeUninstallRestoreResult({ resultFile, result: module.classifyRestoreError(new Error("GAME_RUNNING")) });
  assert.equal(await readFile(resultFile, "utf8"), "GAME_RUNNING");
  assert.throws(() => module.parseUninstallRestoreArguments(["--user-data", f.userData, "--result-file", "relative.json"]), /absolute|INVALID_ARGUMENTS/u);
});

test("headless CLI accepts the exact Inno arguments and atomically reports success or a sanitized failure", async () => {
  const helper = resolve(import.meta.dirname, "../desktop/uninstall-restore.js");
  const clean = await rootFixture(), successFile = join(clean.root, "success.json");
  const success = spawnSync(process.execPath, [helper, "--user-data", clean.userData, "--result-file", successFile], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(await readFile(successFile, "utf8"), "OK");

  const invalid = await rootFixture(), failureFile = join(invalid.root, "failure.json");
  await writeFile(join(invalid.userData, "desktop-settings.json"), JSON.stringify({ clientExe: "relative.exe", secret: "do-not-leak" }));
  const failure = spawnSync(process.execPath, [helper, "--user-data", invalid.userData, "--result-file", failureFile], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  const result = await readFile(failureFile, "utf8");
  assert.equal(result, "PATH_INVALID");
  assert.ok(!result.includes("do-not-leak"));
});
