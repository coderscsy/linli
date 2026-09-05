import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isVerifiedOptionalClientPatch } from "../desktop/client-patch-registry.js";

const execute = promisify(execFile);
const script = await readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8");
const body = script.slice(script.indexOf("if ($PatchNativeOfflineChecks) {"), script.indexOf("$hash = (Get-FileHash"));
const quote = value => `'${value.replaceAll("'", "''")}'`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "olivia-native-widgets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = join(root, "backups");
  const studio = join(root, "0.0.9.627", "plugins", "Studio", "NutStudioUI.dll");
  const container = join(root, "0.0.9.627", "plugins", "Container", "NutContainerPlugin.dll");
  for (const path of [backup, dirname(studio), dirname(container)]) await mkdir(path, { recursive: true });
  const originals = [
    Buffer.from("cbe8d2370800eb1eff15b2ec0800488d8fa8cbe872340800eb1eff1552e90800488d8fa8cbe8b21f0800eb2bff1592d4080084c07514cbe8ff1d0800eb1cff15dfd20800488d4f38", "hex"),
    Buffer.from("488bda488bf9ff1561a4040084c00f85", "hex"),
  ];
  await writeFile(studio, originals[0]);
  await writeFile(container, originals[1]);
  const run = async (prefix = "") => {
    const command = `$ErrorActionPreference='Stop'; $PatchNativeOfflineChecks=$true; $Version='0.0.9.627'; $GameRoot=${quote(root)}; $OriginalFile=${quote(join(backup, "feapp.dat"))}; ${prefix}\n${body}`;
    return execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true });
  };
  return { root, backup, studio, container, originals, run };
}

test("native widget patch changes only the five known gates, preserves originals, and is repeatable", async t => {
  const f = await fixture(t);
  await f.run();
  for (const [index, kind, name, path] of [[0, "studioUi", "NutStudioUI", f.studio], [1, "containerPlugin", "NutContainerPlugin", f.container]]) {
    assert.ok(isVerifiedOptionalClientPatch(kind, f.originals[index], await readFile(path)));
    assert.deepEqual(await readFile(join(f.backup, `${name}-0.0.9.627.dll`)), f.originals[index]);
  }
  await f.run();
  assert.ok(isVerifiedOptionalClientPatch("studioUi", f.originals[0], await readFile(f.studio)));
});

test("unknown second native binary is refused before changing the first", async t => {
  const f = await fixture(t);
  await writeFile(f.container, Buffer.from("unrecognized-build"));
  await assert.rejects(f.run(), /signature missing or ambiguous/u);
  assert.deepEqual(await readFile(f.studio), f.originals[0]);
  await assert.rejects(readFile(join(f.backup, "NutStudioUI-0.0.9.627.dll")), { code: "ENOENT" });
});

test("second native write failure rolls the first binary back", async t => {
  const f = await fixture(t);
  const lock = `$lock=[IO.File]::Open(${quote(f.container)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read);`;
  await assert.rejects(f.run(lock));
  assert.deepEqual(await readFile(f.studio), f.originals[0]);
  assert.deepEqual(await readFile(f.container), f.originals[1]);
});

test("installed native binaries are patched only in isolated copies", { skip: !process.env.OLIVIA_WIDGET_TEST_CLIENT }, async t => {
  const f = await fixture(t);
  const plugins = join(process.env.OLIVIA_WIDGET_TEST_CLIENT, "plugins");
  const originalStudio = await readFile(join(plugins, "Studio", "NutStudioUI.dll"));
  const originalContainer = await readFile(join(plugins, "Container", "NutContainerPlugin.dll"));
  await writeFile(f.studio, originalStudio);
  await writeFile(f.container, originalContainer);
  await f.run();
  assert.ok(isVerifiedOptionalClientPatch("studioUi", originalStudio, await readFile(f.studio)));
  assert.ok(isVerifiedOptionalClientPatch("containerPlugin", originalContainer, await readFile(f.container)));
  assert.deepEqual(await readFile(join(plugins, "Studio", "NutStudioUI.dll")), originalStudio);
  assert.deepEqual(await readFile(join(plugins, "Container", "NutContainerPlugin.dll")), originalContainer);
});
