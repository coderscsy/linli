import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  readClientPatchRegistry,
  registerMountedClientPatch,
} from "../desktop/client-patch-registry.js";
import * as patchRegistry from "../desktop/client-patch-registry.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");

async function fixture(name = "a") {
  const tempRoot = resolve(tmpdir());
  const root = await mkdtemp(join(tempRoot, "client-patch-registry-"));
  after(async () => {
    const target = resolve(root);
    if (dirname(target) !== tempRoot || !/^client-patch-registry-[A-Za-z0-9]+$/u.test(basename(target)))
      throw new Error("unsafe fixture cleanup target");
    await rm(target, { recursive: true, force: true });
  });
  const userData = join(root, "UserData");
  const clientRoot = join(root, `game-${name}`);
  const version = "1.2.3";
  const backupRoot = join(userData, "database", "client-backups", "resources-only", name);
  const targetRoot = join(clientRoot, version, "resources");
  await mkdir(backupRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  const files = [];
  for (const [kind, filename] of [["feapp", "feapp.dat"], ["webplayer", "webplayer.dat"]]) {
    const original = Buffer.from(`${name}-${kind}-original`);
    const patched = Buffer.from(`${name}-${kind}-patched`);
    const backup = join(backupRoot, filename);
    const target = join(targetRoot, filename);
    await writeFile(backup, original);
    await writeFile(target, patched);
    files.push({ kind, target, backup });
  }
  return { root, userData, clientRoot, version, files };
}

test("missing registry is an empty versioned registry without creating UserData files", async () => {
  const f = await fixture();
  assert.deepEqual(await readClientPatchRegistry({ userData: f.userData }), { version: 1, clients: [] });
  await assert.rejects(readdir(join(f.userData, "settings")), { code: "ENOENT" });
});

test("verified mount registration atomically records exact hashes and preserves switched client paths", async () => {
  const first = await fixture("first");
  const secondRoot = join(first.root, "game-second");
  const secondTargetRoot = join(secondRoot, first.version, "resources");
  const secondBackupRoot = join(first.userData, "database", "client-backups", "resources-only", "second");
  await mkdir(secondTargetRoot, { recursive: true });
  await mkdir(secondBackupRoot, { recursive: true });
  const secondFiles = [];
  for (const [kind, filename] of [["feapp", "feapp.dat"], ["webplayer", "webplayer.dat"]]) {
    const backup = join(secondBackupRoot, filename), target = join(secondTargetRoot, filename);
    await writeFile(backup, `second-${kind}-original`);
    await writeFile(target, `second-${kind}-patched`);
    secondFiles.push({ kind, backup, target });
  }
  await registerMountedClientPatch({ userData: first.userData, clientRoot: first.clientRoot, version: first.version, files: first.files });
  await registerMountedClientPatch({ userData: first.userData, clientRoot: secondRoot, version: first.version, files: secondFiles });
  const registry = await readClientPatchRegistry({ userData: first.userData });
  assert.equal(registry.clients.length, 2);
  assert.deepEqual(registry.clients.map(client => client.clientRoot), [first.clientRoot, secondRoot]);
  assert.deepEqual(registry.clients[0].files.map(file => ({
    kind: file.kind,
    target: file.target,
    backup: file.backup,
    originalSha256: file.originalSha256,
    patchedSha256: file.patchedSha256,
    state: file.state,
  })), first.files.map(({ kind, target, backup }) => ({
    kind, target, backup,
    originalSha256: sha256(Buffer.from(`first-${kind}-original`)),
    patchedSha256: sha256(Buffer.from(`first-${kind}-patched`)),
    state: "active",
  })));
  assert.deepEqual((await readdir(join(first.userData, "settings"))).sort(), ["client-patches.json"]);
});

test("concurrent registrations serialize their read-modify-write and preserve both clients", async () => {
  const first = await fixture("race-first");
  const secondRoot = join(first.root, "game-race-second"), version = first.version;
  const targetRoot = join(secondRoot, version, "resources");
  const backupRoot = join(first.userData, "database", "client-backups", "resources-only", "race-second");
  await Promise.all([mkdir(targetRoot, { recursive: true }), mkdir(backupRoot, { recursive: true })]);
  const secondFiles = [];
  for (const [kind, filename] of [["feapp", "feapp.dat"], ["webplayer", "webplayer.dat"]]) {
    const backup = join(backupRoot, filename), target = join(targetRoot, filename);
    await Promise.all([writeFile(backup, `second-${kind}-original`), writeFile(target, `second-${kind}-patched`)]);
    secondFiles.push({ kind, backup, target });
  }
  await Promise.all([
    registerMountedClientPatch({ userData: first.userData, clientRoot: first.clientRoot, version, files: first.files }),
    registerMountedClientPatch({ userData: first.userData, clientRoot: secondRoot, version, files: secondFiles }),
  ]);
  const registry = await readClientPatchRegistry({ userData: first.userData });
  assert.deepEqual(new Set(registry.clients.map(client => client.clientRoot)), new Set([first.clientRoot, secondRoot]));
});

test("registration rejects untrusted backup paths and unchanged targets without creating a registry", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside.dat");
  await writeFile(outside, "outside");
  await assert.rejects(registerMountedClientPatch({
    userData: f.userData, clientRoot: f.clientRoot, version: f.version,
    files: [{ ...f.files[0], backup: outside }, f.files[1]],
  }), /trusted backup|backup path/u);
  await writeFile(f.files[0].target, await readFile(f.files[0].backup));
  await assert.rejects(registerMountedClientPatch({
    userData: f.userData, clientRoot: f.clientRoot, version: f.version, files: f.files,
  }), /patched hash|differs from original/u);
  await assert.rejects(readFile(join(f.userData, "settings", "client-patches.json")), { code: "ENOENT" });
});

test("registration rejects a junction ancestor that escapes the selected client", async () => {
  const f = await fixture();
  const escaped = join(f.root, "escaped-resources");
  await mkdir(escaped, { recursive: true });
  await rm(join(f.clientRoot, f.version, "resources"), { recursive: true });
  await symlink(escaped, join(f.clientRoot, f.version, "resources"), "junction");
  for (const file of f.files) await writeFile(file.target, `escaped-${file.kind}-patched`);
  await assert.rejects(registerMountedClientPatch({
    userData: f.userData, clientRoot: f.clientRoot, version: f.version, files: f.files,
  }), /reparse|link|escapes|real path/u);
  await assert.rejects(readFile(join(f.userData, "settings", "client-patches.json")), { code: "ENOENT" });
});

test("untrusted registry input rejects outside, kind-mismatched, and duplicate targets", async () => {
  const f = await fixture();
  const id = sha256(`${resolve(f.clientRoot).toLowerCase()}\n${f.version.toLowerCase()}`);
  const base = {
    kind: "feapp", target: f.files[0].target, backup: f.files[0].backup,
    originalSha256: "1".repeat(64), patchedSha256: "2".repeat(64), state: "active",
  };
  const writeRaw = async files => {
    await mkdir(join(f.userData, "settings"), { recursive: true });
    await writeFile(join(f.userData, "settings", "client-patches.json"), JSON.stringify({
      version: 1, clients: [{ id, clientRoot: f.clientRoot, version: f.version, state: "active", files }],
    }));
  };
  for (const files of [
    [{ ...base, target: join(f.root, "outside.dat") }, { ...base, kind: "webplayer", target: f.files[1].target, backup: f.files[1].backup }],
    [{ ...base, kind: "webplayer" }, { ...base, kind: "feapp" }],
    [base, { ...base }],
    [{ ...base, target: `${dirname(f.files[0].target)}\\junk\\..\\feapp.dat` }, { ...base, kind: "webplayer", target: f.files[1].target, backup: f.files[1].backup }],
  ]) {
    await writeRaw(files);
    await assert.rejects(readClientPatchRegistry({ userData: f.userData }), /target|kind|duplicate/u);
  }
});

test("registration and raw registry reject traversal or invalid Windows version directory names", async () => {
  const f = await fixture();
  for (const version of [".", "..", "bad:name", "bad. ", "CON", "line\nbreak"]) {
    await assert.rejects(registerMountedClientPatch({
      userData: f.userData, clientRoot: f.clientRoot, version, files: f.files,
    }), /version/u);
  }
  const version = "..", id = sha256(`${resolve(f.clientRoot).toLowerCase()}\n${version}`);
  await mkdir(join(f.userData, "settings"), { recursive: true });
  await writeFile(join(f.userData, "settings", "client-patches.json"), JSON.stringify({
    version: 1,
    clients: [{
      id, clientRoot: f.clientRoot, version, state: "active",
      files: [{ kind: "feapp", target: join(f.clientRoot, "resources", "feapp.dat"), backup: f.files[0].backup, originalSha256: "1".repeat(64), patchedSha256: "2".repeat(64), state: "active" }],
    }],
  }));
  await assert.rejects(readClientPatchRegistry({ userData: f.userData }), /version/u);
});

test("optional DLL discovery accepts only exact Olivia native transforms and never treats NutBase restore as a patch", async () => {
  assert.equal(typeof patchRegistry.discoverVerifiedOptionalClientPatches, "function");
  const f = await fixture("native");
  const backupRoot = dirname(f.files[0].backup);
  const studioTarget = join(f.clientRoot, f.version, "plugins", "Studio", "NutStudioUI.dll");
  const containerTarget = join(f.clientRoot, f.version, "plugins", "Container", "NutContainerPlugin.dll");
  const nutBaseTarget = join(f.clientRoot, f.version, "NutBase.dll");
  await Promise.all([mkdir(dirname(studioTarget), { recursive: true }), mkdir(dirname(containerTarget), { recursive: true })]);

  const studioPatterns = [
    "cbe8d2370800eb1eff15b2ec0800488d8fa8",
    "cbe872340800eb1eff1552e90800488d8fa8",
    "cbe8b21f0800eb2bff1592d4080084c07514",
    "cbe8ff1d0800eb1cff15dfd20800488d4f38",
  ].map(value => Buffer.from(value, "hex"));
  const studioOriginal = Buffer.concat([studioPatterns[2], studioPatterns[0], studioPatterns[3], studioPatterns[1]]
    .map((value, index) => Buffer.concat([Buffer.from([index]), value])));
  const studioPatched = Buffer.from(studioOriginal);
  for (const pattern of studioPatterns) {
    const offset = studioOriginal.indexOf(pattern);
    studioPatched.fill(0x90, offset + 8, offset + 14);
    studioPatched[offset + 8] = 0x33;
    studioPatched[offset + 9] = 0xc0;
  }
  const containerPattern = Buffer.from("488bda488bf9ff1561a4040084c00f85", "hex");
  const containerOriginal = Buffer.concat([Buffer.from("prefix"), containerPattern, Buffer.from("suffix")]);
  const containerPatched = Buffer.from(containerOriginal);
  const containerOffset = containerOriginal.indexOf(containerPattern);
  containerPatched.fill(0x90, containerOffset + 6, containerOffset + 12);
  containerPatched[containerOffset + 6] = 0x33;
  containerPatched[containerOffset + 7] = 0xc0;

  const studioBackup = join(backupRoot, `NutStudioUI-${f.version}.dll`);
  const containerBackup = join(backupRoot, `NutContainerPlugin-${f.version}.dll`);
  const nutBaseBackup = join(backupRoot, `NutBase-${f.version}.dll`);
  await Promise.all([
    writeFile(studioBackup, studioOriginal), writeFile(studioTarget, studioPatched),
    writeFile(containerBackup, containerOriginal), writeFile(containerTarget, containerPatched),
    writeFile(nutBaseBackup, "restored-nut-base"), writeFile(nutBaseTarget, "restored-nut-base"),
  ]);

  assert.deepEqual(await patchRegistry.discoverVerifiedOptionalClientPatches({
    clientRoot: f.clientRoot, version: f.version, feappBackup: f.files[0].backup,
  }), [
    { kind: "studioUi", target: studioTarget, backup: studioBackup },
    { kind: "containerPlugin", target: containerTarget, backup: containerBackup },
  ]);
  await assert.rejects(registerMountedClientPatch({
    userData: f.userData, clientRoot: f.clientRoot, version: f.version,
    files: [...f.files, { kind: "nutBase", target: nutBaseTarget, backup: nutBaseBackup }],
  }), /unsupported/u);

  await writeFile(containerTarget, "not-an-olivia-transform");
  await assert.rejects(patchRegistry.discoverVerifiedOptionalClientPatches({
    clientRoot: f.clientRoot, version: f.version, feappBackup: f.files[0].backup,
  }), /verified|transform|optional/u);
});
