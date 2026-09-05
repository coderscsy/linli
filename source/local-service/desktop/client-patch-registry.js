import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HASH = /^[a-f0-9]{64}$/u;
const FILE_LAYOUT = new Map([
  ["feapp", version => join(version, "resources", "feapp.dat")],
  ["webplayer", version => join(version, "resources", "webplayer.dat")],
  ["studioUi", version => join(version, "plugins", "Studio", "NutStudioUI.dll")],
  ["containerPlugin", version => join(version, "plugins", "Container", "NutContainerPlugin.dll")],
]);
const NATIVE_PATCH = Buffer.from([0x33, 0xc0, 0x90, 0x90, 0x90, 0x90]);
const STUDIO_PATTERNS = [
  "cbe8d2370800eb1eff15b2ec0800488d8fa8",
  "cbe872340800eb1eff1552e90800488d8fa8",
  "cbe8b21f0800eb2bff1592d4080084c07514",
  "cbe8ff1d0800eb1cff15dfd20800488d4f38",
].map(value => Buffer.from(value, "hex"));
const CONTAINER_PATTERN = Buffer.from("488bda488bf9ff1561a4040084c00f85", "hex");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}
function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const normalized = resolve(value);
  if (value.replaceAll("/", "\\").toLowerCase() !== normalized.toLowerCase()) throw new Error(`${label} must be normalized without traversal`);
  return normalized;
}
function validVersion(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value === "." || value === ".."
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(value) || /[. ]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)) throw new Error("invalid client version directory name");
  return value;
}
function clientId(clientRoot, version) {
  return createHash("sha256").update(`${resolve(clientRoot).toLowerCase()}\n${version.toLowerCase()}`).digest("hex");
}
async function regularFile(path, label) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { throw new Error(`${label} is inaccessible or missing: ${error.code ?? error.message}`, { cause: error }); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file`);
}

async function existingRegularFile(path, label) {
  try { await regularFile(path, label); return true; }
  catch (error) {
    if (error.cause?.code === "ENOENT") return false;
    throw error;
  }
}

function applyNativePatch(original, patterns, patchOffset) {
  const expected = Buffer.from(original);
  for (const pattern of patterns) {
    const offset = original.indexOf(pattern);
    if (offset < 0 || original.indexOf(pattern, offset + 1) >= 0) return null;
    NATIVE_PATCH.copy(expected, offset + patchOffset);
  }
  return expected;
}

export function isVerifiedOptionalClientPatch(kind, original, current) {
  if (!Buffer.isBuffer(original) || !Buffer.isBuffer(current)) return false;
  const expected = kind === "studioUi"
    ? applyNativePatch(original, STUDIO_PATTERNS, 8)
    : kind === "containerPlugin" ? applyNativePatch(original, [CONTAINER_PATTERN], 6) : null;
  return Boolean(expected?.equals(current));
}

export function hasNativeWidgetPatch(kind, current) {
  const patterns = kind === "studioUi" ? STUDIO_PATTERNS : kind === "containerPlugin" ? [CONTAINER_PATTERN] : [];
  const patchOffset = kind === "studioUi" ? 8 : 6;
  return patterns.length > 0 && patterns.every(pattern => {
    if (current.indexOf(pattern) >= 0) return false;
    const patched = Buffer.from(pattern);
    NATIVE_PATCH.copy(patched, patchOffset);
    const offset = current.indexOf(patched);
    return offset >= 0 && current.indexOf(patched, offset + 1) < 0;
  });
}

export async function discoverVerifiedOptionalClientPatches({ clientRoot, version, feappBackup }) {
  const root = absolute(clientRoot, "client root"), backupRoot = dirname(absolute(feappBackup, "FE backup path"));
  validVersion(version);
  const candidates = [
    { kind: "studioUi", target: join(root, version, "plugins", "Studio", "NutStudioUI.dll"), backup: join(backupRoot, `NutStudioUI-${version}.dll`) },
    { kind: "containerPlugin", target: join(root, version, "plugins", "Container", "NutContainerPlugin.dll"), backup: join(backupRoot, `NutContainerPlugin-${version}.dll`) },
  ];
  const verified = [];
  for (const candidate of candidates) {
    if (!await existingRegularFile(candidate.backup, `${candidate.kind} backup`)) continue;
    if (!await existingRegularFile(candidate.target, `${candidate.kind} target`)) throw new Error(`optional ${candidate.kind} target is missing`);
    const [original, current] = await Promise.all([readFile(candidate.backup), readFile(candidate.target)]);
    if (original.equals(current)) continue;
    if (!isVerifiedOptionalClientPatch(candidate.kind, original, current))
      throw new Error(`optional ${candidate.kind} target is not a verified Olivia native transform`);
    verified.push(candidate);
  }
  return verified;
}

export async function assertRegisteredFilePaths({ userData, clientRoot, version, file }) {
  validVersion(version);
  const root = absolute(clientRoot, "client root"), target = absolute(file.target, "target path"), backup = absolute(file.backup, "backup path");
  if (!FILE_LAYOUT.has(file.kind) || !samePath(target, join(root, FILE_LAYOUT.get(file.kind)(version))))
    throw new Error("registered target path does not match client identity");
  const backupRoot = join(resolve(userData), "database", "client-backups");
  if (!inside(backupRoot, backup)) throw new Error("registered backup path is outside trusted backup storage");
  const [realUserData, realBackupRoot, realBackup, realRoot, realVersion, realTarget] = await Promise.all([
    realpath(resolve(userData)), realpath(backupRoot), realpath(backup), realpath(root), realpath(join(root, version)), realpath(target),
  ]).catch(error => { throw new Error(`registered path real path is inaccessible: ${error.code ?? error.message}`, { cause: error }); });
  if (!samePath(realUserData, resolve(userData)) || !inside(realUserData, realBackupRoot)
    || !samePath(realBackupRoot, backupRoot) || !inside(realBackupRoot, realBackup)
    || !samePath(realRoot, root) || !samePath(realVersion, join(root, version)) || !inside(realRoot, realVersion)
    || !inside(realVersion, realTarget) || !samePath(realTarget, target))
    throw new Error("registered path escapes through a reparse point or link");
}

async function assertPlannedRegisteredFilePaths({ userData, clientRoot, version, file }) {
  validVersion(version);
  const root = absolute(clientRoot, "client root"), target = absolute(file.target, "target path"), backup = absolute(file.backup, "backup path");
  if (!FILE_LAYOUT.has(file.kind) || !samePath(target, join(root, FILE_LAYOUT.get(file.kind)(version))))
    throw new Error("planned target path does not match client identity");
  const backupRoot = join(resolve(userData), "database", "client-backups"), backupParent = dirname(backup);
  if (!inside(backupRoot, backup)) throw new Error("planned backup path is outside trusted backup storage");
  const [realUserData, realBackupRoot, realBackupParent, realRoot, realVersion, realTarget] = await Promise.all([
    realpath(resolve(userData)), realpath(backupRoot), realpath(backupParent), realpath(root), realpath(join(root, version)), realpath(target),
  ]).catch(error => { throw new Error(`planned path real path is inaccessible: ${error.code ?? error.message}`, { cause: error }); });
  if (!samePath(realUserData, resolve(userData)) || !inside(realUserData, realBackupRoot)
    || !samePath(realBackupRoot, backupRoot) || !inside(realBackupRoot, realBackupParent) || !samePath(realBackupParent, backupParent)
    || !samePath(realRoot, root) || !samePath(realVersion, join(root, version)) || !inside(realRoot, realVersion)
    || !inside(realVersion, realTarget) || !samePath(realTarget, target))
    throw new Error("planned path escapes through a reparse point or link");
}

export function clientPatchRegistryPath(userData) {
  return join(resolve(userData), "settings", "client-patches.json");
}

export async function withClientPatchRegistryLock(userData, run, { timeoutMs = 10_000 } = {}) {
  const directory = dirname(clientPatchRegistryPath(userData));
  const lockPath = join(directory, "client-patches.lock");
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try { handle = await open(lockPath, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("client patch registry is busy", { cause: error });
      await delay(10);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return await run();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export function validateClientPatchRegistry(value, userData) {
  if (value?.version !== 1 || !Array.isArray(value.clients)) throw new Error("invalid client patch registry");
  const ids = new Set();
  for (const client of value.clients) {
    const root = absolute(client?.clientRoot, "client root");
    validVersion(client.version);
    if (client.id !== clientId(root, client.version) || ids.has(client.id)) throw new Error("invalid or duplicate client identity");
    ids.add(client.id);
    if (!['active', 'restored'].includes(client.state) || !Array.isArray(client.files) || client.files.length === 0)
      throw new Error("invalid client patch state");
    const kinds = new Set();
    for (const file of client.files) {
      if (!FILE_LAYOUT.has(file?.kind) || kinds.has(file.kind)) throw new Error("invalid or duplicate registered file kind");
      kinds.add(file.kind);
      const target = absolute(file.target, "target path"), backup = absolute(file.backup, "backup path");
      if (!samePath(target, join(root, FILE_LAYOUT.get(file.kind)(client.version)))) throw new Error("registered target path does not match client identity");
      if (!inside(join(resolve(userData), "database", "client-backups"), backup)) throw new Error("registered backup path is outside trusted backup storage");
      if (!HASH.test(file.originalSha256) || !HASH.test(file.patchedSha256) || file.originalSha256 === file.patchedSha256)
        throw new Error("invalid registered file hashes");
      if (!['active', 'restored'].includes(file.state)) throw new Error("invalid registered file state");
    }
    if (client.state === "restored" && client.files.some(file => file.state !== "restored")) throw new Error("inconsistent restored client state");
  }
  return value;
}

export async function readClientPatchRegistry({ userData }) {
  const path = clientPatchRegistryPath(userData);
  try { return validateClientPatchRegistry(JSON.parse(await readFile(path, "utf8")), userData); }
  catch (error) {
    if (error.code === "ENOENT") return { version: 1, clients: [] };
    throw error;
  }
}

export async function writeClientPatchRegistry({ userData, registry }) {
  validateClientPatchRegistry(registry, userData);
  const path = clientPatchRegistryPath(userData), directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.client-patches-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareMountedClientPatchRecord({ userData, clientRoot, version, files, plannedBackups = new Map() }) {
  const root = absolute(clientRoot, "client root");
  validVersion(version);
  if (!Array.isArray(files) || files.length < 2) throw new Error("verified mount requires registered files");
  const registered = [];
  for (const file of files) {
    if (!FILE_LAYOUT.has(file?.kind)) throw new Error("unsupported registered file kind");
    const target = absolute(file.target, "target path"), backup = absolute(file.backup, "backup path");
    if (!samePath(target, join(root, FILE_LAYOUT.get(file.kind)(version)))) throw new Error("target path does not match the selected client");
    if (!inside(join(resolve(userData), "database", "client-backups"), backup)) throw new Error("backup path is outside trusted backup storage");
    const plannedBytes = plannedBackups.get(backup.toLowerCase());
    await regularFile(target, "patched target");
    let originalBytes;
    if (plannedBytes) {
      if (!Buffer.isBuffer(plannedBytes)) throw new Error("planned backup bytes are invalid");
      if (await existingRegularFile(backup, "planned backup")) throw new Error("planned backup unexpectedly already exists");
      await assertPlannedRegisteredFilePaths({ userData, clientRoot: root, version, file: { ...file, target, backup } });
      originalBytes = plannedBytes;
    } else {
      await regularFile(backup, "trusted backup");
      await assertRegisteredFilePaths({ userData, clientRoot: root, version, file: { ...file, target, backup } });
      originalBytes = await readFile(backup);
    }
    const patchedBytes = await readFile(target);
    if (originalBytes.includes(Buffer.from("OliviaSoulPatch"))) throw new Error("trusted backup contains an OliviaSoul patch marker");
    const originalSha256 = sha256(originalBytes), patchedSha256 = sha256(patchedBytes);
    if (originalSha256 === patchedSha256) throw new Error("patched hash must differ from original hash");
    registered.push({ kind: file.kind, target, backup, originalSha256, patchedSha256, state: "active" });
  }
  if (new Set(registered.map(file => file.kind)).size !== registered.length) throw new Error("duplicate registered file kind");
  const id = clientId(root, version);
  return { id, clientRoot: root, version, state: "active", files: registered };
}

export function upsertClientPatchRecord(registry, record) {
  const index = registry.clients.findIndex(client => client.id === record.id);
  if (index < 0) registry.clients.push(record); else registry.clients[index] = record;
  return registry;
}

export async function registerMountedClientPatch(options) {
  const record = await prepareMountedClientPatchRecord(options);
  await withClientPatchRegistryLock(options.userData, async () => {
    const registry = await readClientPatchRegistry({ userData: options.userData });
    const index = registry.clients.findIndex(client => client.id === record.id);
    if (index < 0) registry.clients.push(record); else registry.clients[index] = record;
    await writeClientPatchRegistry({ userData: options.userData, registry });
  });
  return record;
}

export async function markRegisteredClientRestored({ userData, clientRoot, version }) {
  return withClientPatchRegistryLock(userData, async () => {
    const registry = await readClientPatchRegistry({ userData });
    const record = registry.clients.find(client => client.id === clientId(clientRoot, version));
    if (!record) return false;
    for (const file of record.files) file.state = "restored";
    record.state = "restored";
    await writeClientPatchRegistry({ userData, registry });
    return true;
  });
}
