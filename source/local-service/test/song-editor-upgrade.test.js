import test from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { DesktopController } from "../desktop/controller.js";

function fixture({ revision = "v28", webCurrent = true, failPatch = false } = {}) {
  const controller = new DesktopController({ root: "fixture", dataDir: "fixture-data", appData: "fixture-settings" });
  const calls = [], originals = [];
  const layout = { gameRoot: "fixture-game", version: "0.0.9.627", feappPath: "feapp.dat", webplayerPath: "webplayer.dat" };
  controller.selectedClientLayout = async () => layout;
  controller.readFeappStatus = async () => ({ revision, updateAvailable: true });
  controller.readWebplayerStatus = async () => ({ mounted: webCurrent, port: webCurrent ? 27149 : null, updateAvailable: false });
  controller.originalClientBackups = async () => {
    originals.push("pair");
    return { feapp: "pristine-feapp.dat", webplayer: "pristine-webplayer.dat" };
  };
  // Mock only process/file/service boundaries; execute the real upgrade orchestration.
  controller.clientWrite = async (script, args) => {
    calls.push({ script: basename(script), args });
    if (failPatch && basename(script) === "patch-feapp-local.ps1") throw new Error("fixture patch failed");
  };
  controller.changeServicePort = async port => calls.push({ port });
  controller.getClientStatus = async () => ({ mounted: true, revision: "v30" });
  controller.registerCurrentClientPatch = async () => {};
  // Native backup discovery is an additional filesystem boundary in R10.
  controller.nativeRestoreArgs = async () => ["-RestoreStudioUi", true, "-RestoreContainerPlugin", true];
  return { controller, calls, originals };
}

async function assertFeOnlyUpgrade(revision) {
  const { controller, calls, originals } = fixture({ revision });
  const status = await controller.mountClient(27149);
  assert.deepEqual(originals, ["pair"]);
  assert.deepEqual(calls, [
    { script: "patch-feapp-local.ps1", args: ["-GameRoot", "fixture-game", "-Version", "0.0.9.627", "-OriginalFile", "pristine-feapp.dat", "-PatchNativeOfflineChecks", true, "-ServiceUrl", "http://127.0.0.1:27149"] },
    { port: 27149 },
  ]);
  assert.deepEqual(status, { mounted: true, revision: "v30" });
}

test("theme upgrade rebuilds v28 FE from pristine backup and leaves a current same-port webplayer untouched", async () => {
  await assertFeOnlyUpgrade("v28");
});

test("v29 widget resync upgrade rebuilds only FE and leaves a current same-port webplayer untouched", async () => {
  await assertFeOnlyUpgrade("v29");
});

test("failed v28 theme patch restores only FE and never restarts the service", async () => {
  const { controller, calls } = fixture({ failPatch: true });
  await assert.rejects(controller.mountClient(27149), /fixture patch failed/);
  assert.deepEqual(calls.map(call => call.script), ["patch-feapp-local.ps1", "restore-feapp-original.ps1"]);
  assert.equal(calls[1].args[calls[1].args.indexOf("-OriginalFile") + 1], "pristine-feapp.dat");
  assert.deepEqual(calls[1].args.slice(-4), ["-RestoreStudioUi", true, "-RestoreContainerPlugin", true]);
});

test("v28 with missing webplayer still installs both required resources", async () => {
  const { controller, calls, originals } = fixture({ webCurrent: false });
  await controller.mountClient(27149);
  assert.deepEqual(originals, ["pair"]);
  assert.deepEqual(calls.filter(call => call.script).map(call => call.script), ["patch-feapp-local.ps1", "patch-webplayer-local.ps1"]);
});

test("earlier v27 upgrade retains its existing full resource rebuild", async () => {
  const { controller, calls } = fixture({ revision: "v27" });
  await controller.mountClient(27149);
  assert.deepEqual(calls.filter(call => call.script).map(call => call.script), ["patch-feapp-local.ps1", "patch-webplayer-local.ps1"]);
});
