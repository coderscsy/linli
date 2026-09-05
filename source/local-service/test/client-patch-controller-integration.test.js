import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { DesktopController } from "../desktop/controller.js";
import { discoverVerifiedOptionalClientPatches, readClientPatchRegistry, registerMountedClientPatch } from "../desktop/client-patch-registry.js";

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

function fixture() {
  const root = join(tmpdir(), "olivia-client-patch-controller");
  const controller = new DesktopController({ root, dataDir: join(root, "UserData", "database"), appData: join(root, "UserData"), executable: join(root, "OliviaSoul.exe") });
  const layout = {
    gameRoot: join(root, "game"), version: "1.2.3",
    feappPath: join(root, "game", "1.2.3", "resources", "feapp.dat"),
    webplayerPath: join(root, "game", "1.2.3", "resources", "webplayer.dat"),
  };
  const backups = {
    feapp: join(root, "UserData", "database", "client-backups", "resources-only", "x", "feapp.dat"),
    webplayer: join(root, "UserData", "database", "client-backups", "resources-only", "x", "webplayer.dat"),
  };
  const state = { feapp: false, webplayer: false };
  const events = [];
  controller.clientExePath = join(layout.gameRoot, "Olivia.exe");
  controller.selectedClientLayout = async () => layout;
  controller.originalClientBackups = async () => backups;
  controller.readFeappStatus = async () => ({ clientFound: true, mounted: state.feapp, managed: state.feapp, updateAvailable: false, port: state.feapp ? 27149 : null });
  controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: state.webplayer, managed: state.webplayer, updateAvailable: false, port: state.webplayer ? 27149 : null });
  controller.clientWrite = async (script, args) => {
    const name = basename(script), kind = name.includes("webplayer") ? "webplayer" : "feapp";
    events.push([name, args.at(-1)]);
    state[kind] = !name.startsWith("restore-");
  };
  controller.changeServicePort = async () => 27149;
  controller.registerCurrentClientPatch = async () => { events.push(["register"]); };
  controller.markCurrentClientRestored = async () => { events.push(["mark-restored"]); };
  return { controller, state, events, backups };
}

test("mount registration occurs only after read-after mounted verification", async () => {
  const f = fixture();
  const originalStatus = f.controller.getClientStatus.bind(f.controller);
  f.controller.getClientStatus = async () => { f.events.push(["read-after"]); return originalStatus(); };
  await f.controller.mountClient(27149);
  assert.deepEqual(f.events.map(item => item[0]), ["patch-feapp-local.ps1", "patch-webplayer-local.ps1", "read-after", "register"]);

  const failed = fixture();
  failed.controller.getClientStatus = async () => ({ clientSelected: true, clientFound: true, webplayerFound: true, mounted: false, feappMounted: false, webplayerMounted: false });
  await assert.rejects(failed.controller.mountClient(27149), error => error.stage === "verify-mounted");
  assert.ok(!failed.events.some(item => item[0] === "register"));
});

test("registration failure restores this mount from its trusted FE and WebPlayer originals", async () => {
  const f = fixture();
  f.controller.registerCurrentClientPatch = async () => { throw new Error("REGISTRY_WRITE_FAILED"); };
  await assert.rejects(f.controller.mountClient(27149), /REGISTRY_WRITE_FAILED/u);
  assert.deepEqual(f.events.slice(-2), [
    ["restore-feapp-original.ps1", f.backups.feapp],
    ["restore-webplayer-original.ps1", f.backups.webplayer],
  ]);
  assert.deepEqual(f.state, { feapp: false, webplayer: false });
});

test("registration rollback reuses the originals proven before mount when later backup discovery fails", async () => {
  const f = fixture();
  let reads = 0;
  f.controller.originalClientBackups = async () => {
    if (++reads === 1) return f.backups;
    throw new Error("OPTIONAL_BACKUP_CONFLICT");
  };
  f.controller.registerCurrentClientPatch = async () => { throw new Error("REGISTRY_WRITE_FAILED"); };
  await assert.rejects(f.controller.mountClient(27149), /REGISTRY_WRITE_FAILED/u);
  assert.deepEqual(f.state, { feapp: false, webplayer: false });
  assert.equal(reads, 1);
});

test("manual restore marks only the verified selected registration restored", async () => {
  const f = fixture();
  f.state.feapp = true; f.state.webplayer = true;
  await f.controller.restoreClient();
  assert.equal(f.events.at(-1)[0], "mark-restored");
  assert.deepEqual(f.state, { feapp: false, webplayer: false });
});

test("desktop backend readiness never waits for legacy registry adoption", async () => {
  const f = fixture();
  let backendCreated = false;
  f.controller.readRuntimeSettings = async () => ({ port: 27149, clientExe: "" });
  f.controller.createOwnedBackend = async () => { backendCreated = true; };
  f.controller.adoptLegacySelectedClientPatch = async () => new Promise(() => {});
  const outcome = await Promise.race([
    f.controller.initialize().then(() => "ready"),
    new Promise(resolve => setTimeout(() => resolve("timeout"), 50)),
  ]);
  assert.equal(outcome, "ready");
  assert.equal(backendCreated, true);
});

test("controller registers exact Studio and Container native patches but not an unchanged NutBase", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-controller-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "UserData"), clientRoot = join(root, "game"), version = "1.2.3";
  const resources = join(clientRoot, version, "resources"), backupRoot = join(userData, "database", "client-backups", "resources-only", "exact");
  const layout = {
    gameRoot: clientRoot, version,
    feappPath: join(resources, "feapp.dat"), webplayerPath: join(resources, "webplayer.dat"),
  };
  await Promise.all([
    mkdir(resources, { recursive: true }),
    mkdir(join(clientRoot, version, "plugins", "Studio"), { recursive: true }),
    mkdir(join(clientRoot, version, "plugins", "Container"), { recursive: true }),
    mkdir(backupRoot, { recursive: true }),
  ]);
  const feappBackup = join(backupRoot, "exact.feapp.dat"), webplayerBackup = join(backupRoot, "exact.webplayer.dat");
  await Promise.all([
    writeFile(feappBackup, "original-fe"), writeFile(layout.feappPath, "patched-fe"),
    writeFile(webplayerBackup, "original-wp"), writeFile(layout.webplayerPath, "patched-wp"),
  ]);

  const studioPatterns = [
    "cbe8d2370800eb1eff15b2ec0800488d8fa8", "cbe872340800eb1eff1552e90800488d8fa8",
    "cbe8b21f0800eb2bff1592d4080084c07514", "cbe8ff1d0800eb1cff15dfd20800488d4f38",
  ].map(value => Buffer.from(value, "hex"));
  const studioOriginal = Buffer.concat(studioPatterns), studioPatched = Buffer.from(studioOriginal);
  for (const pattern of studioPatterns) {
    const offset = studioOriginal.indexOf(pattern);
    Buffer.from([0x33, 0xc0, 0x90, 0x90, 0x90, 0x90]).copy(studioPatched, offset + 8);
  }
  const containerPattern = Buffer.from("488bda488bf9ff1561a4040084c00f85", "hex");
  const containerOriginal = Buffer.concat([Buffer.from("before"), containerPattern, Buffer.from("after")]);
  const containerPatched = Buffer.from(containerOriginal);
  Buffer.from([0x33, 0xc0, 0x90, 0x90, 0x90, 0x90]).copy(containerPatched, containerOriginal.indexOf(containerPattern) + 6);
  const native = [
    [join(backupRoot, `NutStudioUI-${version}.dll`), join(clientRoot, version, "plugins", "Studio", "NutStudioUI.dll"), studioOriginal, studioPatched],
    [join(backupRoot, `NutContainerPlugin-${version}.dll`), join(clientRoot, version, "plugins", "Container", "NutContainerPlugin.dll"), containerOriginal, containerPatched],
    [join(backupRoot, `NutBase-${version}.dll`), join(clientRoot, version, "NutBase.dll"), Buffer.from("clean-nut-base"), Buffer.from("clean-nut-base")],
  ];
  await Promise.all(native.flatMap(([backup, target, original, patched]) => [writeFile(backup, original), writeFile(target, patched)]));

  const controller = new DesktopController({ root, dataDir: join(userData, "database"), appData: userData, executable: join(root, "OliviaSoul.exe") });
  controller.selectedClientLayout = async () => layout;
  controller.originalClientBackups = async () => ({ feapp: feappBackup, webplayer: webplayerBackup });
  await controller.registerCurrentClientPatch();

  const [record] = (await readClientPatchRegistry({ userData })).clients;
  assert.deepEqual(record.files.map(file => file.kind), ["feapp", "webplayer", "studioUi", "containerPlugin"]);
  for (const file of record.files) {
    assert.equal((await readFile(file.target)).equals(await readFile(file.backup)), false);
    assert.match(file.originalSha256, /^[a-f0-9]{64}$/u);
    assert.match(file.patchedSha256, /^[a-f0-9]{64}$/u);
  }
});

test("registration failure restores and verifies every exact optional DLL changed by this mount", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-controller-native-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "UserData"), clientRoot = join(root, "game"), version = "1.2.3";
  const backupRoot = join(userData, "database", "client-backups", "resources-only", "exact");
  const layout = {
    gameRoot: clientRoot, version,
    feappPath: join(clientRoot, version, "resources", "feapp.dat"),
    webplayerPath: join(clientRoot, version, "resources", "webplayer.dat"),
  };
  const files = {
    feappBackup: join(backupRoot, "exact.feapp.dat"), webplayerBackup: join(backupRoot, "exact.webplayer.dat"),
    studioBackup: join(backupRoot, `NutStudioUI-${version}.dll`),
    studioTarget: join(clientRoot, version, "plugins", "Studio", "NutStudioUI.dll"),
    containerBackup: join(backupRoot, `NutContainerPlugin-${version}.dll`),
    containerTarget: join(clientRoot, version, "plugins", "Container", "NutContainerPlugin.dll"),
  };
  await Promise.all([
    mkdir(join(clientRoot, version, "resources"), { recursive: true }), mkdir(dirname(files.studioTarget), { recursive: true }),
    mkdir(dirname(files.containerTarget), { recursive: true }), mkdir(backupRoot, { recursive: true }),
  ]);
  const bytes = nativeDllBytes();
  await Promise.all([
    writeFile(files.feappBackup, "original-fe"), writeFile(layout.feappPath, "original-fe"),
    writeFile(files.webplayerBackup, "original-wp"), writeFile(layout.webplayerPath, "original-wp"),
    writeFile(files.studioBackup, bytes.studioOriginal), writeFile(files.studioTarget, bytes.studioOriginal),
    writeFile(files.containerBackup, bytes.containerOriginal), writeFile(files.containerTarget, bytes.containerOriginal),
  ]);
  const controller = new DesktopController({ root, dataDir: join(userData, "database"), appData: userData, executable: join(root, "OliviaSoul.exe") });
  controller.selectedClientLayout = async () => layout;
  controller.originalClientBackups = async () => ({ feapp: files.feappBackup, webplayer: files.webplayerBackup });
  const state = { feapp: false, webplayer: false }, writes = [];
  controller.readFeappStatus = async () => ({ clientFound: true, mounted: state.feapp, managed: state.feapp, updateAvailable: false, port: 27149 });
  controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: state.webplayer, managed: state.webplayer, updateAvailable: false, port: 27149 });
  controller.changeServicePort = async () => 27149;
  controller.clientWrite = async (script, args) => {
    const name = basename(script); writes.push({ name, args });
    if (name === "patch-feapp-local.ps1") {
      state.feapp = true;
      await Promise.all([writeFile(layout.feappPath, "patched-fe"), writeFile(files.studioTarget, bytes.studioPatched), writeFile(files.containerTarget, bytes.containerPatched)]);
    } else if (name === "patch-webplayer-local.ps1") {
      state.webplayer = true; await writeFile(layout.webplayerPath, "patched-wp");
    } else if (name === "restore-feapp-original.ps1") {
      state.feapp = false; await writeFile(layout.feappPath, "original-fe");
      if (args.includes("-RestoreStudioUi")) await writeFile(files.studioTarget, bytes.studioOriginal);
      if (args.includes("-RestoreContainerPlugin")) await writeFile(files.containerTarget, bytes.containerOriginal);
    } else if (name === "restore-webplayer-original.ps1") {
      state.webplayer = false; await writeFile(layout.webplayerPath, "original-wp");
    }
  };
  controller.registerCurrentClientPatch = async () => {
    await discoverVerifiedOptionalClientPatches({ clientRoot, version, feappBackup: files.feappBackup });
    throw new Error("REGISTRY_WRITE_FAILED");
  };

  await assert.rejects(controller.mountClient(27149), /REGISTRY_WRITE_FAILED/u);

  assert.equal((await readFile(files.studioTarget)).equals(bytes.studioOriginal), true);
  assert.equal((await readFile(files.containerTarget)).equals(bytes.containerOriginal), true);
  const restore = writes.find(write => write.name === "restore-feapp-original.ps1");
  assert.equal(restore.args.includes("-RestoreStudioUi"), true);
  assert.equal(restore.args.includes("-RestoreContainerPlugin"), true);
});

test("manual restore refuses a missing registered optional backup before writes and never marks it restored", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-controller-native-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "UserData"), clientRoot = join(root, "game"), version = "1.2.3";
  const resources = join(clientRoot, version, "resources"), backupRoot = join(userData, "database", "client-backups", "resources-only", "exact");
  const layout = { gameRoot: clientRoot, version, feappPath: join(resources, "feapp.dat"), webplayerPath: join(resources, "webplayer.dat") };
  const studioTarget = join(clientRoot, version, "plugins", "Studio", "NutStudioUI.dll");
  const files = [
    { kind: "feapp", target: layout.feappPath, backup: join(backupRoot, "exact.feapp.dat") },
    { kind: "webplayer", target: layout.webplayerPath, backup: join(backupRoot, "exact.webplayer.dat") },
    { kind: "studioUi", target: studioTarget, backup: join(backupRoot, `NutStudioUI-${version}.dll`) },
  ];
  await Promise.all([mkdir(resources, { recursive: true }), mkdir(dirname(studioTarget), { recursive: true }), mkdir(backupRoot, { recursive: true })]);
  for (const file of files) {
    await writeFile(file.backup, `original-${file.kind}`);
    await writeFile(file.target, `patched-${file.kind}`);
  }
  await registerMountedClientPatch({ userData, clientRoot, version, files });
  await unlink(files[2].backup);

  const controller = new DesktopController({ root, dataDir: join(userData, "database"), appData: userData, executable: join(root, "OliviaSoul.exe") });
  controller.selectedClientLayout = async () => layout;
  controller.originalClientBackups = async () => ({ feapp: files[0].backup, webplayer: files[1].backup });
  controller.readFeappStatus = async () => ({ clientFound: true, mounted: true, managed: true, updateAvailable: false, port: 27149 });
  controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: true, managed: true, updateAvailable: false, port: 27149 });
  const writes = [];
  controller.clientWrite = async (...args) => { writes.push(args); };
  let marked = false;
  controller.markCurrentClientRestored = async () => { marked = true; };

  await assert.rejects(controller.restoreClient(), /studioUi|backup|missing|inaccessible/u);
  assert.deepEqual(writes, []);
  assert.equal(marked, false);
  assert.equal((await readClientPatchRegistry({ userData })).clients[0].state, "active");
});

test("manual restore freezes client identity and rejects selection changes until the exact record is marked", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-controller-restore-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "UserData"), version = "1.2.3";
  const clients = {};
  for (const name of ["a", "b"]) {
    const gameRoot = join(root, `game-${name}`), resourceRoot = join(gameRoot, version, "resources");
    const backupRoot = join(userData, "database", "client-backups", "resources-only", name);
    await Promise.all([mkdir(resourceRoot, { recursive: true }), mkdir(backupRoot, { recursive: true })]);
    const files = [
      { kind: "feapp", target: join(resourceRoot, "feapp.dat"), backup: join(backupRoot, `${name}.feapp.dat`) },
      { kind: "webplayer", target: join(resourceRoot, "webplayer.dat"), backup: join(backupRoot, `${name}.webplayer.dat`) },
    ];
    for (const file of files) {
      await writeFile(file.backup, `${name}-${file.kind}-original`);
      await writeFile(file.target, `${name}-${file.kind}-patched`);
    }
    await registerMountedClientPatch({ userData, clientRoot: gameRoot, version, files });
    clients[name] = {
      exe: join(gameRoot, "Olivia.exe"),
      layout: { gameRoot, version, feappPath: files[0].target, webplayerPath: files[1].target },
      files,
    };
  }

  const controller = new DesktopController({ root, dataDir: join(userData, "database"), appData: userData, executable: join(root, "OliviaSoul.exe") });
  controller.clientExePath = clients.a.exe;
  controller.selectedClientLayout = async () => controller.clientExePath === clients.a.exe ? clients.a.layout : clients.b.layout;
  controller.writeRuntimeSettings = async () => {};
  controller.originalClientBackups = async layout => {
    const selected = layout.gameRoot === clients.a.layout.gameRoot ? clients.a : clients.b;
    return { feapp: selected.files[0].backup, webplayer: selected.files[1].backup };
  };
  controller.readFeappStatus = async path => ({ clientFound: true, mounted: (await readFile(path, "utf8")).endsWith("patched"), managed: false, updateAvailable: false });
  controller.readWebplayerStatus = controller.readFeappStatus;
  let releaseFirstWrite;
  const firstWriteStarted = new Promise(resolvePromise => { releaseFirstWrite = resolvePromise; });
  let blocked = true;
  controller.clientWrite = async (script, args) => {
    const gameRoot = args[args.indexOf("-GameRoot") + 1];
    const selected = gameRoot === clients.a.layout.gameRoot ? clients.a : clients.b;
    const kind = basename(script).includes("webplayer") ? "webplayer" : "feapp";
    if (blocked) {
      blocked = false;
      const continueWrite = new Promise(resolvePromise => { controller.continueRestore = resolvePromise; });
      releaseFirstWrite();
      await continueWrite;
    }
    const file = selected.files.find(item => item.kind === kind);
    await writeFile(file.target, await readFile(file.backup));
  };

  const restoring = controller.restoreClient();
  await firstWriteStarted;
  await assert.rejects(controller.setClient(clients.b.exe), error => error.code === "CLIENT_SERVICE_BUSY");
  controller.continueRestore();
  await restoring;

  assert.equal(controller.clientExePath, clients.a.exe);
  const records = (await readClientPatchRegistry({ userData })).clients;
  assert.equal(records.find(record => record.clientRoot === clients.a.layout.gameRoot).state, "restored");
  assert.equal(records.find(record => record.clientRoot === clients.b.layout.gameRoot).state, "active");
});
