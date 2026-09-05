import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { beforeEach } from "node:test";
import { DesktopController } from "../desktop/controller.js";

// These orchestration fixtures model a local disk. Only replace the new OS
// path probe; dispatch, operation guards and existing assertions remain real.
beforeEach(t => {
  const original = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    const code = Buffer.from(args.at(-1), "base64").toString("utf16le");
    if (!code.includes("Win32_LogicalDisk")) return original(command, args, options);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => { child.stdout.emit("data", Buffer.from("local")); child.emit("close", 0); });
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
});

function fixture() {
  const root = join(tmpdir(), "olivia-controller-no-io");
  const controller = new DesktopController({ root, dataDir: join(root, "data"),
    appData: join(root, "app-data"), executable: join(root, "OliviaSoul.exe") });
  const layout = { gameRoot: join(root, "game"), version: "test-version",
    feappPath: join(root, "game", "feapp.dat"), webplayerPath: join(root, "game", "webplayer.dat") };
  const backups = { feapp: join(root, "resources-only", "original.feapp.dat"),
    webplayer: join(root, "resources-only", "original.webplayer.dat") };
  const state = { feapp: true, webplayer: true };
  const writes = [];
  controller.clientExePath = join(layout.gameRoot, "game.exe");
  controller.selectedClientLayout = async () => layout;
  controller.readFeappStatus = async () => ({ clientFound: true, mounted: state.feapp, port: 27149 });
  controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: state.webplayer });
  controller.originalFeapp = async () => backups.feapp;
  controller.originalWebplayer = async () => backups.webplayer;
  controller.originalClientBackups = async () => backups;
  controller.registerCurrentClientPatch = async () => {};
  controller.markCurrentClientRestored = async () => {};
  controller.changeServicePort = async () => 27149;
  controller.runElevatedScript = async (script, args) => {
    writes.push({ script: basename(script), args });
    const kind = script.includes("webplayer") ? "webplayer" : "feapp";
    state[kind] = !basename(script).startsWith("restore-");
  };
  return { controller, layout, backups, state, writes };
}

test("627 mount includes the native widget gates on clean installs and current v31 repairs", async () => {
  for (const revision of [null, "v31"]) {
    const ctx = fixture();
    ctx.layout.version = "0.0.9.627";
    ctx.controller.readNativeWidgetStatus = async () => ({ required: true, ready: true });
    ctx.state.feapp = Boolean(revision);
    ctx.controller.readFeappStatus = async () => ({ clientFound: true, mounted: ctx.state.feapp, revision, port: 27149 });
    ctx.controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: true, port: 27149 });
    await ctx.controller.mountClient(27149);
    const call = ctx.writes.find(item => item.script === "patch-feapp-local.ps1");
    const flag = call.args.indexOf("-PatchNativeOfflineChecks");
    assert.ok(flag >= 0, "real mount must enable the native widget patch");
    assert.equal(call.args[flag + 1], true);
    if (revision) assert.equal(ctx.writes.some(item => item.script.includes("webplayer")), false);
  }
});

test("v31 archives alone cannot report fully mounted while native widget gates remain original", async t => {
  const ctx = fixture();
  const root = await mkdtemp(join(tmpdir(), "olivia-widget-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  ctx.layout.gameRoot = root;
  ctx.layout.version = "0.0.9.627";
  const studio = Buffer.concat([
    Buffer.from("cbe8d2370800eb1eff15b2ec0800488d8fa8", "hex"),
    Buffer.from("cbe872340800eb1eff1552e90800488d8fa8", "hex"),
    Buffer.from("cbe8b21f0800eb2bff1592d4080084c07514", "hex"),
    Buffer.from("cbe8ff1d0800eb1cff15dfd20800488d4f38", "hex"),
  ]);
  const container = Buffer.from("488bda488bf9ff1561a4040084c00f85", "hex");
  const studioPath = join(root, ctx.layout.version, "plugins", "Studio", "NutStudioUI.dll");
  const containerPath = join(root, ctx.layout.version, "plugins", "Container", "NutContainerPlugin.dll");
  await mkdir(join(root, ctx.layout.version, "plugins", "Studio"), { recursive: true });
  await mkdir(join(root, ctx.layout.version, "plugins", "Container"), { recursive: true });
  await writeFile(studioPath, studio);
  await writeFile(containerPath, container);
  assert.equal((await ctx.controller.getClientStatus()).mounted, false);
  for (const offset of [8, 26, 44, 62]) Buffer.from("33c090909090", "hex").copy(studio, offset);
  Buffer.from("33c090909090", "hex").copy(container, 6);
  await writeFile(studioPath, studio);
  await writeFile(containerPath, container);
  assert.equal((await ctx.controller.getClientStatus()).mounted, true);
  await writeFile(containerPath, Buffer.from("unknown-client-build"));
  assert.equal((await ctx.controller.getClientStatus()).mounted, false);
});

test("paired backup failure stops restore before either game mutation and names its stage", async () => {
  const ctx = fixture();
  ctx.controller.originalClientBackups = async () => { throw new Error("Ambiguous original backups"); };
  await assert.rejects(ctx.controller.restoreClient(), error =>
    error.stage === "originals" && /Ambiguous original backups/u.test(error.message));
  assert.deepEqual(ctx.writes, []);
  assert.deepEqual(ctx.state, { feapp: true, webplayer: true });
});

test("restore verifies both archives instead of accepting successful helper exits", async () => {
  const ctx = fixture();
  ctx.controller.runElevatedScript = async () => {};
  await assert.rejects(ctx.controller.restoreClient(), error => error.stage === "verify-restored");
  assert.deepEqual(ctx.state, { feapp: true, webplayer: true });
});

test("successful restore reports separate confirmed FE and WP state", async () => {
  const ctx = fixture();
  const status = await ctx.controller.restoreClient();
  assert.equal(status.mounted, false);
  assert.equal(status.feappMounted, false);
  assert.equal(status.webplayerMounted, false);
  assert.deepEqual(ctx.writes.map(item => [item.script, item.args.at(-1)]), [
    ["restore-feapp-original.ps1", ctx.backups.feapp],
    ["restore-webplayer-original.ps1", ctx.backups.webplayer],
  ]);
});

test("an active elevated restore keeps mount and restore mutually excluded until completion", async () => {
  const ctx = fixture();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const write = ctx.controller.runElevatedScript;
  let first = true;
  ctx.controller.runElevatedScript = async (...args) => {
    if (first) { first = false; entered(); await hold; }
    return write(...args);
  };
  const pending = ctx.controller.restoreClient();
  try {
    await ready;
    await assert.rejects(ctx.controller.mountClient(27149), error => error.code === "CLIENT_SERVICE_BUSY");
    await assert.rejects(ctx.controller.restoreClient(), error => error.code === "CLIENT_SERVICE_BUSY");
    assert.deepEqual(ctx.writes, []);
  } finally { release(); await pending; }
  assert.equal((await ctx.controller.mountClient(27149)).mounted, true);
});

test("client status distinguishes partially mounted archives and an unselected client", async () => {
  const ctx = fixture();
  ctx.state.webplayer = false;
  const partial = await ctx.controller.getClientStatus();
  assert.equal(partial.mounted, false);
  assert.equal(partial.feappMounted, true);
  assert.equal(partial.webplayerMounted, false);
  ctx.controller.selectedClientLayout = async () => null;
  const absent = await ctx.controller.getClientStatus();
  assert.equal(absent.clientSelected, false);
  assert.equal(absent.feappMounted, false);
  assert.equal(absent.webplayerMounted, false);
});

test("read-only status subprocesses time out without waiting indefinitely", { concurrency: false }, async t => {
  const original = childProcess.spawn;
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = () => true;
  childProcess.spawn = () => process;
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending;
  try {
    const ctx = fixture();
    pending = DesktopController.prototype.readFeappStatus.call(ctx.controller, ctx.layout.feappPath)
      .then(value => ({ value }), error => ({ error }));
    t.mock.timers.tick(15000);
    const outcome = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve({}))) ]);
    assert.equal(outcome.error?.code, "CLIENT_SERVICE_STATUS_TIMEOUT");
  } finally {
    process.stdout.emit("data", Buffer.from('{"clientFound":true,"mounted":false}'));
    process.emit("close", 0);
    await pending;
    t.mock.timers.reset();
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test("elevated RefreshOriginal uses PowerShell switch binding without a positional true argument", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-switch-binding-"));
  const script = join(root, "switch-fixture.ps1");
  await writeFile(script, "param([Parameter(Mandatory=$true)][string]$OriginalFile, [switch]$RefreshOriginal, [switch]$RestoreStudioUi)\n[ordered]@{ original = $OriginalFile; refresh = [bool]$RefreshOriginal; restoreStudio = [bool]$RestoreStudioUi } | ConvertTo-Json -Compress\n");
  const original = childProcess.spawn;
  let output = "";
  // Execute only the already-formatted inner command against an isolated
  // literal parameter fixture; never invoke elevation or a game script.
  childProcess.spawn = (command, args, options) => {
    const outer = Buffer.from(args.at(-1), "base64").toString("utf16le");
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(outer)?.[1];
    assert.ok(encoded);
    const child = original(command, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], options);
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    return child;
  };
  syncBuiltinESMExports();
  try {
    const controller = new DesktopController({ root, dataDir: root, appData: root, executable: join(root, "unused.exe") });
    await controller.runElevatedScript(script, ["-OriginalFile", "literal ' original.dat", "-RefreshOriginal", "true"]);
    assert.deepEqual(JSON.parse(output), { original: "literal ' original.dat", refresh: true, restoreStudio: false });
    output = "";
    await controller.runElevatedScript(script, ["-OriginalFile", "original.dat", "-RefreshOriginal", false]);
    assert.deepEqual(JSON.parse(output), { original: "original.dat", refresh: false, restoreStudio: false });
    output = "";
    await controller.runElevatedScript(script, ["-OriginalFile", "original.dat", "-RestoreStudioUi", true]);
    assert.deepEqual(JSON.parse(output), { original: "original.dat", refresh: false, restoreStudio: true });
    output = "";
    await writeFile(script, "param([Parameter(Mandatory=$true)][string]$OriginalFile, [switch]$PatchNativeOfflineChecks)\n[ordered]@{ native = [bool]$PatchNativeOfflineChecks } | ConvertTo-Json -Compress\n");
    await controller.runElevatedScript(script, ["-OriginalFile", "original.dat", "-PatchNativeOfflineChecks", true]);
    assert.deepEqual(JSON.parse(output), { native: true });
    await assert.rejects(controller.runElevatedScript(script,
      ["-RefreshOriginal", "true; Write-Output unexpected"]), /RefreshOriginal/u);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy managed patches and missing archives cannot be confirmed as fully restored", async () => {
  for (const feapp of [
    { clientFound: true, mounted: false, managed: true, updateAvailable: true },
    { clientFound: false, mounted: false },
  ]) {
    const ctx = fixture();
    ctx.controller.readFeappStatus = async () => feapp;
    ctx.controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: false, managed: false });
    ctx.controller.runElevatedScript = async () => {};
    await assert.rejects(ctx.controller.restoreClient(), error => error.stage === "verify-restored");
    if (feapp.managed) assert.equal((await ctx.controller.getClientStatus()).feappMounted, true);
  }
  const ctx = fixture();
  ctx.controller.readWebplayerStatus = async () => ({ clientFound: true, mounted: false, managed: true, updateAvailable: true });
  assert.equal((await ctx.controller.getClientStatus()).webplayerMounted, true);
});

test("mount registers only after mounted verification succeeds", async () => {
  const ctx = fixture();
  const events = [];
  ctx.state.feapp = false;
  ctx.state.webplayer = false;
  ctx.controller.readFeappStatus = async () => {
    if (ctx.state.feapp) events.push("verify-feapp");
    return { clientFound: true, mounted: ctx.state.feapp, port: 27149 };
  };
  ctx.controller.readWebplayerStatus = async () => {
    if (ctx.state.webplayer) events.push("verify-webplayer");
    return { clientFound: true, mounted: ctx.state.webplayer };
  };
  ctx.controller.registerCurrentClientPatch = async () => { events.push("register"); };

  await ctx.controller.mountClient(27149);

  assert.deepEqual(events.slice(-3), ["verify-feapp", "verify-webplayer", "register"]);
});

test("v30 upgrades FE from the verified original and preserves a current same-port WebPlayer", async () => {
  const ctx = fixture();
  ctx.controller.readFeappStatus = async () => ({
    clientFound: true, mounted: false, managed: true, updateAvailable: true, revision: "v30", port: 27149,
  });
  ctx.controller.readWebplayerStatus = async () => ({
    clientFound: true, mounted: true, managed: true, updateAvailable: false, revision: "v13", port: 27149,
  });
  ctx.controller.getClientStatus = async () => ({ mounted: true, feappMounted: true, webplayerMounted: true });

  const status = await ctx.controller.mountClientResources(27149);

  assert.deepEqual(ctx.writes, [{
    script: "patch-feapp-local.ps1",
    args: [
      "-GameRoot", ctx.layout.gameRoot,
      "-Version", ctx.layout.version,
      "-OriginalFile", ctx.backups.feapp,
      "-ServiceUrl", "http://127.0.0.1:27149",
    ],
  }]);
  assert.deepEqual(status, { mounted: true, feappMounted: true, webplayerMounted: true });
});

test("registration failure rolls this mount's FE and WebPlayer writes back", async () => {
  const ctx = fixture();
  ctx.state.feapp = false;
  ctx.state.webplayer = false;
  ctx.controller.registerCurrentClientPatch = async () => { throw new Error("REGISTRY_WRITE_FAILED"); };

  await assert.rejects(ctx.controller.mountClient(27149), error =>
    error.stage === "register" && /REGISTRY_WRITE_FAILED/u.test(error.message));

  assert.deepEqual(ctx.state, { feapp: false, webplayer: false });
  assert.deepEqual(ctx.writes.map(item => item.script), [
    "patch-feapp-local.ps1",
    "patch-webplayer-local.ps1",
    "restore-feapp-original.ps1",
    "restore-webplayer-original.ps1",
  ]);
});

test("restore marks the selected registry record only after restored verification", async () => {
  const ctx = fixture();
  const events = [];
  ctx.controller.readFeappStatus = async () => {
    events.push("verify-feapp");
    return { clientFound: true, mounted: ctx.state.feapp, port: 27149 };
  };
  ctx.controller.readWebplayerStatus = async () => {
    events.push("verify-webplayer");
    return { clientFound: true, mounted: ctx.state.webplayer };
  };
  ctx.controller.markCurrentClientRestored = async () => { events.push("mark-restored"); };

  await ctx.controller.restoreClient();

  assert.deepEqual(events, ["verify-feapp", "verify-webplayer", "mark-restored"]);
});

test("initialize creates the backend without starting or waiting for legacy patch adoption", async () => {
  const ctx = fixture();
  const events = [];
  ctx.controller.readRuntimeSettings = async () => ({ port: 27149, clientExe: "" });
  ctx.controller.createOwnedBackend = async port => { events.push(["backend", port]); };
  ctx.controller.adoptLegacySelectedClientPatch = async () => {
    events.push(["legacy-adoption"]);
    await new Promise(() => {});
  };

  const initialized = await Promise.race([
    ctx.controller.initialize().then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ]);

  assert.equal(initialized, true);
  assert.deepEqual(events, [["backend", 27149]]);
});

test("first mount and port-failure rollback never refresh already verified staged originals", async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const ctx = fixture();
  ctx.state.feapp = false;
  ctx.state.webplayer = false;
  ctx.controller.changeServicePort = async () => { throw new Error("test port switch failed"); };
  await assert.rejects(ctx.controller.mountClient(port), /test port switch failed/u);
  assert.equal(ctx.writes.length, 4, "initial FE/WP mount plus FE/WP port rollback");
  for (const command of ctx.writes) {
    assert.equal(command.args.includes("-RefreshOriginal"), false,
      "rollback must not replace verified originals with the now-patched live archives");
  }
});
