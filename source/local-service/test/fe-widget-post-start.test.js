import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const patch = await readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8");

function singleQuotedPatchValue(name) {
  const value = patch.match(new RegExp(`^\\$${name} = '([^\\r\\n]*)'\\r?$`, "mu"))?.[1];
  assert.ok(value, `expected one ${name} patch literal`);
  return value;
}

async function executeOfflineStart(snippet, {
  starts = true,
  rejectWidget = false,
  rejectToggle = "",
  throwWidget = false,
  throwToggle = "",
} = {}) {
  const calls = [];
  const context = vm.createContext({
    M: "offline-user",
    Cn: "offline-token",
    h: async () => { calls.push("startClientApp"); return starts; },
    Fm(payload) {
      calls.push({ updateSettings: { ...payload } });
      if (throwWidget) throw new Error("widget update threw");
      return rejectWidget ? Promise.reject(new Error("widget update failed")) : Promise.resolve();
    },
    Z: {
      toggleLetterEntry(payload) {
        calls.push({ toggleLetterEntry: { ...payload } });
        if (throwToggle === "letter") throw new Error("letter toggle threw");
        return rejectToggle === "letter" ? Promise.reject(new Error("letter toggle failed")) : Promise.resolve();
      },
      toggleMusicEntry(payload) {
        calls.push({ toggleMusicEntry: { ...payload } });
        if (throwToggle === "music") throw new Error("music toggle threw");
        return rejectToggle === "music" ? Promise.reject(new Error("music toggle failed")) : Promise.resolve();
      },
    },
    A: { load: async () => { calls.push("libraryLoad"); } },
  });
  await vm.runInContext(`(async()=>{${snippet}})()`, context);
  return calls;
}

test("offline start uses the real FE replacement to resync desktop widgets before loading the library", async () => {
  const from = singleQuotedPatchValue("offlineWidgetResyncFrom");
  const to = singleQuotedPatchValue("offlineWidgetResyncTo");
  assert.equal(patch.split(from).length - 1, 1, "clean v627 anchor must occur exactly once");
  assert.equal(patch.split(to).length - 1, 1, "patched replacement must occur exactly once");
  assert.doesNotMatch(patch, /usersettings\.dat|\$userSettingsPath|\$widgetLock(?:From|To)/u,
    "the FE patch must not directly mutate usersettings.dat");

  assert.deepEqual(await executeOfflineStart(to), [
    "startClientApp",
    { updateSettings: { mailWidget: true, musicWidget: true } },
    { toggleLetterEntry: { new_status: true } },
    { toggleMusicEntry: { new_status: true } },
    "libraryLoad",
  ]);
  assert.deepEqual(await executeOfflineStart(to, { rejectWidget: true }), [
    "startClientApp",
    { updateSettings: { mailWidget: true, musicWidget: true } },
    { toggleLetterEntry: { new_status: true } },
    { toggleMusicEntry: { new_status: true } },
    "libraryLoad",
  ], "a rejected widget update must not block the library load");
  assert.deepEqual(await executeOfflineStart(to, { throwWidget: true }), [
    "startClientApp",
    { updateSettings: { mailWidget: true, musicWidget: true } },
    { toggleLetterEntry: { new_status: true } },
    { toggleMusicEntry: { new_status: true } },
    "libraryLoad",
  ], "a synchronous widget update failure must not block native toggles or the library load");
  for (const rejectToggle of ["letter", "music"]) {
    assert.deepEqual(await executeOfflineStart(to, { rejectToggle }), [
      "startClientApp",
      { updateSettings: { mailWidget: true, musicWidget: true } },
      { toggleLetterEntry: { new_status: true } },
      { toggleMusicEntry: { new_status: true } },
      "libraryLoad",
    ], `a rejected ${rejectToggle} native toggle must not block its peer or the library load`);
  }
  for (const throwToggle of ["letter", "music"]) {
    assert.deepEqual(await executeOfflineStart(to, { throwToggle }), [
      "startClientApp",
      { updateSettings: { mailWidget: true, musicWidget: true } },
      { toggleLetterEntry: { new_status: true } },
      { toggleMusicEntry: { new_status: true } },
      "libraryLoad",
    ], `a synchronous ${throwToggle} native toggle failure must not block its peer or the library load`);
  }
  assert.deepEqual(await executeOfflineStart(to, { starts: false }), ["startClientApp"],
    "a failed start must not update widgets or load the offline library");
});
