import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commitVerifiedOptionalClientBackups,
  inspectClientArchive,
  planVerifiedOptionalClientBackups,
  sameClientArchiveIdentity,
} from "./client-backups.js";
import {
  assertRegisteredFilePaths,
  prepareMountedClientPatchRecord,
  readClientPatchRegistry,
  upsertClientPatchRecord,
  withClientPatchRegistryLock,
  writeClientPatchRegistry,
} from "./client-patch-registry.js";

const runFile = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}
async function regularFile(path, label) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { throw new Error(`${label} is inaccessible or missing: ${error.code ?? error.message}`, { cause: error }); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file`);
}

function normalizedAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const normalized = resolve(value);
  if (value.replaceAll("/", "\\").toLowerCase() !== normalized.toLowerCase())
    throw new Error(`${label} must be normalized without traversal`);
  return normalized;
}

async function assertCanonicalFileWithin(allowedRootValue, fileValue, label) {
  const allowedRoot = normalizedAbsolutePath(allowedRootValue, `${label} allowed root`);
  const file = normalizedAbsolutePath(fileValue, label);
  if (!inside(allowedRoot, file)) throw new Error(`${label} is outside its allowed root`);
  await regularFile(file, label);
  for (let directory = dirname(file);;) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} ancestor is a reparse point or link`);
    if (resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase())
      throw new Error(`${label} ancestor canonical identity mismatch`);
    if (resolve(directory).toLowerCase() === allowedRoot.toLowerCase()) break;
    if (!inside(allowedRoot, directory)) throw new Error(`${label} ancestor escaped its allowed root`);
    directory = dirname(directory);
  }
  if (resolve(await realpath(file)).toLowerCase() !== file.toLowerCase())
    throw new Error(`${label} canonical identity mismatch`);
  return file;
}

async function validateSteamManifestPaths(directory, manifest) {
  const backupPath = normalizedAbsolutePath(manifest.backupPath, "Steam backup path");
  const configPath = normalizedAbsolutePath(manifest.configPath, "Steam config path");
  const configDirectory = dirname(configPath), userDirectory = dirname(configDirectory), userdataDirectory = dirname(userDirectory);
  if (basename(configPath).toLowerCase() !== "localconfig.vdf" || basename(configDirectory).toLowerCase() !== "config"
    || !/^[1-9]\d{0,19}$/u.test(basename(userDirectory)) || basename(userdataDirectory).toLowerCase() !== "userdata")
    throw new Error("Steam config path is outside the supported userdata layout");
  const steamRoot = dirname(userdataDirectory);
  await regularFile(join(steamRoot, "steam.exe"), "Steam installation marker");
  await Promise.all([
    assertCanonicalFileWithin(steamRoot, configPath, "Steam config path"),
    assertCanonicalFileWithin(resolve(directory), backupPath, "Steam backup path"),
  ]);
  return { configPath, backupPath };
}

async function bundledTool(userData, ...parts) {
  const appRoot = dirname(resolve(userData));
  const candidates = [
    join(appRoot, "resources", "workspace-template", "tools", ...parts),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", ...parts),
  ];
  for (const path of candidates) {
    try { await regularFile(path, "packaged restore tool"); return path; }
    catch (error) { if (!/inaccessible or missing/u.test(error.message)) throw error; }
  }
  throw new Error("packaged restore tool is missing");
}

async function defaultLegacyPatchStatus(userData, kind, path) {
  const script = await bundledTool(userData, kind === "feapp" ? "get-feapp-status.ps1" : "get-webplayer-status.ps1");
  const parameter = kind === "feapp" ? "FeappPath" : "WebplayerPath";
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = `& ${quote(script)} -${parameter} ${quote(path)}`;
  const { stdout } = await runFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout.replace(/^\uFEFF/u, ""));
}

async function defaultValidateLegacyArchivePair({ originals, targets, statuses }) {
  const [originalFe, currentFe, originalWp, currentWp] = await Promise.all([
    inspectClientArchive(originals.feapp), inspectClientArchive(targets.feapp),
    inspectClientArchive(originals.webplayer), inspectClientArchive(targets.webplayer),
  ]);
  if (originalFe.patched || originalWp.patched || !currentFe.patched || !currentWp.patched) return false;
  return sameClientArchiveIdentity(originalFe, currentFe, {
    allowKnownFeLocale: currentFe.knownFeLocalePatch && ["v29", "v30", "v31", "v32"].includes(statuses.feapp.revision),
  }) && sameClientArchiveIdentity(originalWp, currentWp);
}

async function discoverLegacySelectedClient({ userData, registry, readLegacyPatchStatus, validateLegacyArchivePair }) {
  let settings;
  try { settings = JSON.parse(await readFile(join(userData, "desktop-settings.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("legacy selected client settings are invalid", { cause: error }); }
  if (!settings?.clientExe) return null;
  if (typeof settings.clientExe !== "string" || !isAbsolute(settings.clientExe) || extname(settings.clientExe).toLowerCase() !== ".exe")
    throw new Error("legacy selected client path is invalid");
  const clientExe = resolve(settings.clientExe);
  await regularFile(clientExe, "legacy selected client executable");
  if (resolve(await realpath(clientExe)).toLowerCase() !== clientExe.toLowerCase()) throw new Error("legacy selected client path uses a reparse point or link");
  const clientRoot = dirname(clientExe), candidates = [];
  for (const entry of await readdir(clientRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const targets = {
      feapp: join(clientRoot, entry.name, "resources", "feapp.dat"),
      webplayer: join(clientRoot, entry.name, "resources", "webplayer.dat"),
    };
    try { await Promise.all([regularFile(targets.feapp, "legacy FE target"), regularFile(targets.webplayer, "legacy WebPlayer target")]); candidates.push({ version: entry.name, targets }); }
    catch (error) { if (!/inaccessible or missing: ENOENT/u.test(error.message)) throw error; }
  }
  if (candidates.length !== 1) throw new Error(`legacy selected client requires one unique version, found ${candidates.length}`);
  const { version, targets } = candidates[0];
  const existing = registry.clients.find(client => client.clientRoot.toLowerCase() === clientRoot.toLowerCase() && client.version.toLowerCase() === version.toLowerCase());
  if (existing?.state === "active") return null;
  const statuses = {
    feapp: await readLegacyPatchStatus("feapp", targets.feapp),
    webplayer: await readLegacyPatchStatus("webplayer", targets.webplayer),
  };
  const clean = Object.values(statuses).every(status => status.clientFound === true && !status.mounted && !status.managed && !status.updateAvailable);
  if (clean) return null;
  if (!Object.values(statuses).every(status => status.clientFound === true && status.mounted === true && status.managed === true && !status.updateAvailable))
    throw new Error("legacy selected client is not a strictly verified mounted pair");
  const key = createHash("md5").update(`${clientRoot.toLowerCase()}\n${version.toLowerCase()}`).digest("hex");
  const stage = join(userData, "database", "client-backups", "resources-only", key);
  const originals = { feapp: join(stage, `${key}.feapp.dat`), webplayer: join(stage, `${key}.webplayer.dat`) };
  let stagedNames;
  try { stagedNames = (await readdir(stage)).sort(); }
  catch (error) { throw new Error("legacy exact staged backup pair is missing", { cause: error }); }
  const requiredNames = [`${key}.feapp.dat`, `${key}.webplayer.dat`];
  const allowedNames = new Set([...requiredNames,
    `NutStudioUI-${version}.dll`, `NutContainerPlugin-${version}.dll`]);
  if (!requiredNames.every(name => stagedNames.includes(name)) || stagedNames.some(name => !allowedNames.has(name)))
    throw new Error("legacy exact staged backup pair is missing or ambiguous");
  const backupStatuses = {
    feapp: await readLegacyPatchStatus("feapp", originals.feapp),
    webplayer: await readLegacyPatchStatus("webplayer", originals.webplayer),
  };
  if (!Object.values(backupStatuses).every(status => status.clientFound === true && !status.mounted && !status.managed && !status.updateAvailable))
    throw new Error("legacy exact staged backup pair is not clean");
  if (!await validateLegacyArchivePair({ originals, targets, statuses, backupStatuses })) throw new Error("legacy exact staged backup pair identity mismatch");
  const optionalStagePlan = await planVerifiedOptionalClientBackups({
    layout: { gameRoot: clientRoot, version }, dataDir: join(userData, "database"), appData: userData,
  });
  return {
    userData, clientRoot, version, optionalStagePlan,
    files: [
      { kind: "feapp", target: targets.feapp, backup: originals.feapp },
      { kind: "webplayer", target: targets.webplayer, backup: originals.webplayer },
      ...optionalStagePlan.files,
    ],
  };
}

export function canonicalProcessRoot(root) {
  return resolve(root).replace(/[\\/]+$/u, "");
}

export async function assertProtectedProcessesStopped(clientRoots) {
  if (process.platform !== "win32") throw new Error("WINDOWS_REQUIRED");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const roots = clientRoots.map(canonicalProcessRoot);
  const script = `$ErrorActionPreference='Stop';
if(Get-Process -Name steam,steamwebhelper -ErrorAction SilentlyContinue){exit 23};
$roots=@(${roots.map(quote).join(",")});
foreach($process in Get-CimInstance Win32_Process){$path=[string]$process.ExecutablePath;if(-not $path){continue};foreach($root in $roots){if($path.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)){exit 24}}};exit 0`;
  try {
    await runFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  } catch (error) {
    if (error.code === 23) throw new Error("STEAM_RUNNING");
    if (error.code === 24) throw new Error("GAME_RUNNING");
    throw new Error("PROTECTED_PROCESS_STATE_UNAVAILABLE", { cause: error });
  }
}

async function atomicReplace(path, bytes, expectedBeforeHash) {
  const directory = dirname(path), temporary = join(directory, `.olivia-restore-${randomUUID()}.tmp`);
  try {
    const mode = (await lstat(path)).mode;
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (sha256(await readFile(path)) !== expectedBeforeHash) throw new Error("target changed after preflight");
    await rename(temporary, path);
    if (sha256(await readFile(path)) !== sha256(bytes)) throw new Error("restored target hash verification failed");
  } finally { await rm(temporary, { force: true }); }
}

async function loadSteamEditor(userData) {
  return import(pathToFileURL(await bundledTool(userData, "steam-launcher", "steam-launch-options.mjs")).href);
}

async function steamPreflight(userData) {
  const directory = join(userData, "Backups", "steam-launcher");
  let names;
  try { names = (await readdir(directory)).filter(name => name.toLowerCase().endsWith(".json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (names.length === 0) return null;
  const { readLaunchOptions, editLaunchOptions } = await loadSteamEditor(userData);
  const candidates = [], restored = [];
  let installManifests = 0, changedManifests = 0;
  for (const name of names) {
    const manifestPath = join(directory, name);
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { throw new Error("INVALID_STEAM_RESTORE_MANIFEST", { cause: error }); }
    if (manifest?.mode === "restore") continue;
    if (manifest?.mode !== "install") throw new Error("INVALID_STEAM_RESTORE_MANIFEST");
    installManifests++;
    if (manifest?.version !== 1 || !/^[1-9]\d{0,9}$/u.test(String(manifest.appId))
      || typeof manifest.configPath !== "string" || !isAbsolute(manifest.configPath)
      || typeof manifest.installedOptions !== "string"
      || !(manifest.originalOptions === null || typeof manifest.originalOptions === "string")
      || typeof manifest.backupPath !== "string" || !inside(directory, manifest.backupPath)
      || !/^[a-f0-9]{64}$/iu.test(manifest.originalHash ?? "")) throw new Error("INVALID_STEAM_RESTORE_MANIFEST");
    const { configPath, backupPath } = await validateSteamManifestPaths(directory, manifest);
    const backupBytes = await readFile(backupPath);
    if (sha256(backupBytes) !== manifest.originalHash.toLowerCase()) throw new Error("STEAM_BACKUP_HASH_MISMATCH");
    const configBytes = await readFile(configPath), configText = configBytes.toString("utf8");
    if (!Buffer.from(configText, "utf8").equals(configBytes)) throw new Error("UNSUPPORTED_STEAM_CONFIG_ENCODING");
    const current = readLaunchOptions(configText, manifest.appId);
    const item = { manifest: { ...manifest, configPath, backupPath }, configBytes, currentHash: sha256(configBytes), updated: Buffer.from(editLaunchOptions(configText, manifest.appId, manifest.originalOptions), "utf8") };
    if (current === manifest.installedOptions) candidates.push(item);
    else if (current === manifest.originalOptions) restored.push(item);
    else changedManifests++;
  }
  if (changedManifests > 0) throw new Error("STEAM_OPTIONS_CHANGED");
  if (candidates.length > 1) throw new Error("STEAM_MANIFEST_CONFLICT");
  if (candidates.length === 1) return candidates[0];
  if (installManifests === 0) return null;
  if (restored.length > 0) return null;
  throw new Error("STEAM_OPTIONS_CHANGED");
}

export async function restoreAllClientPatches({
  userData,
  assertProtectedProcessesStopped: processGuard = assertProtectedProcessesStopped,
  replaceFile = atomicReplace,
  readLegacyPatchStatus = (kind, path) => defaultLegacyPatchStatus(resolve(userData), kind, path),
  validateLegacyArchivePair = defaultValidateLegacyArchivePair,
}) {
  const absoluteUserData = resolve(userData);
  const registry = await readClientPatchRegistry({ userData: absoluteUserData });
  const registrySnapshot = JSON.stringify(registry);
  const adoption = await discoverLegacySelectedClient({
    userData: absoluteUserData, registry, readLegacyPatchStatus, validateLegacyArchivePair,
  });
  const activeClients = registry.clients.filter(client => client.state === "active");
  const plannedBackups = new Map((adoption?.optionalStagePlan.plans ?? [])
    .map(item => [resolve(item.path).toLowerCase(), item.bytes]));
  const prepareAdoption = () => adoption ? prepareMountedClientPatchRecord({ ...adoption, plannedBackups }) : null;
  let adopted = await prepareAdoption();
  let restoreClients = [...activeClients, ...(adopted ? [adopted] : [])];

  const preflightClients = async clients => {
    const result = [];
    for (const client of clients) for (const file of client.files.filter(file => file.state === "active")) {
      const plannedBackup = plannedBackups.get(resolve(file.backup).toLowerCase());
      if (!plannedBackup) {
        await assertRegisteredFilePaths({ userData: absoluteUserData, clientRoot: client.clientRoot, version: client.version, file });
        await regularFile(file.backup, "registered backup");
      }
      await regularFile(file.target, "registered target");
      const [backupBytes, targetBytes] = await Promise.all([
        plannedBackup ? Promise.resolve(plannedBackup) : readFile(file.backup), readFile(file.target),
      ]);
      if (backupBytes.includes(Buffer.from("OliviaSoulPatch"))) throw new Error("registered backup contains OliviaSoul patch data");
      if (sha256(backupBytes) !== file.originalSha256) throw new Error("registered backup hash mismatch");
      const targetHash = sha256(targetBytes);
      if (targetHash !== file.patchedSha256 && targetHash !== file.originalSha256) throw new Error("registered target was user-modified or is in an unexpected state");
      result.push({ client, file, backupBytes, targetBytes, targetHash, needsWrite: targetHash === file.patchedSha256 });
    }
    return result;
  };
  let plans = await preflightClients(restoreClients);
  let steam = await steamPreflight(absoluteUserData);
  const guardedRoots = [...new Set(restoreClients.map(client => client.clientRoot))];
  if (restoreClients.length > 0 || steam) await processGuard(guardedRoots);

  // Close the read/process TOCTOU window as far as possible: rebuild the exact
  // adoption record and every restore plan after the first process check. No
  // sidecar, registry, client, or Steam write has happened at this point.
  adopted = await prepareAdoption();
  restoreClients = [...activeClients, ...(adopted ? [adopted] : [])];
  plans = await preflightClients(restoreClients);
  steam = await steamPreflight(absoluteUserData);

  const commitRestore = async () => {
    if (restoreClients.length > 0) {
      const currentRegistry = await readClientPatchRegistry({ userData: absoluteUserData });
      if (JSON.stringify(currentRegistry) !== registrySnapshot) throw new Error("CLIENT_PATCH_REGISTRY_CHANGED");
    }
    if (adopted) {
      await commitVerifiedOptionalClientBackups(adoption.optionalStagePlan);
      upsertClientPatchRecord(registry, adopted);
      await writeClientPatchRegistry({ userData: absoluteUserData, registry });
    }

    let restoredFiles = 0, restoredClients = 0;
    for (const client of restoreClients) {
      const clientPlans = plans.filter(plan => plan.client === client), changed = [];
      try {
        for (const plan of clientPlans) {
          if (plan.needsWrite) {
            await replaceFile(plan.file.target, plan.backupBytes, plan.targetHash);
            changed.push(plan);
          }
        }
        for (const plan of clientPlans) plan.file.state = "restored";
        client.state = client.files.every(file => file.state === "restored") ? "restored" : "active";
        await writeClientPatchRegistry({ userData: absoluteUserData, registry });
        restoredFiles += clientPlans.length;
        if (client.state === "restored") restoredClients++;
      } catch (error) {
        const rollbackErrors = [];
        for (const plan of changed.reverse()) {
          try { await atomicReplace(plan.file.target, plan.targetBytes, plan.file.originalSha256); }
          catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
        }
        for (const plan of clientPlans) plan.file.state = "active";
        client.state = "active";
        try { await writeClientPatchRegistry({ userData: absoluteUserData, registry }); }
        catch (registryError) { rollbackErrors.push(`registry: ${registryError.message}`); }
        if (rollbackErrors.length) throw new Error(`${error.message}; rollback incomplete: ${rollbackErrors.join("; ")}`, { cause: error });
        throw error;
      }
    }
    if (steam) await atomicReplace(steam.manifest.configPath, steam.updated, steam.currentHash);
    return {
      restoredClients,
      restoredFiles,
      steamRestored: Boolean(steam),
    };
  };
  return restoreClients.length > 0
    ? withClientPatchRegistryLock(absoluteUserData, commitRestore)
    : commitRestore();
}

export function classifyRestoreError(error) {
  const message = String(error?.message ?? error);
  if (message.includes("GAME_RUNNING")) return { success: false, code: "GAME_RUNNING", message: "请先完全退出游戏后重试。" };
  if (message.includes("STEAM_RUNNING")) return { success: false, code: "STEAM_RUNNING", message: "请先完全退出 Steam 后重试。" };
  if (/backup|archive|staged pair|STEAM_BACKUP/iu.test(message)) return { success: false, code: "BACKUP_INVALID", message: "客户端原始备份缺失、损坏或身份不匹配，请保留 UserData 和备份并联系支持。" };
  if (/path|inaccessible|missing|reparse|link|unique version/iu.test(message)) return { success: false, code: "PATH_INVALID", message: "已登记客户端路径不可访问或不再唯一，请恢复原路径后重试。" };
  if (/modified|unexpected|changed|OPTIONS_CHANGED/iu.test(message)) return { success: false, code: "TARGET_CHANGED", message: "客户端或 Steam 启动项已被后来修改；为避免覆盖用户修改，卸载已停止。" };
  return { success: false, code: "RESTORE_FAILED", message: "安全恢复未完成，请保留 Olivia Soul、UserData 和备份后联系支持。" };
}

export function parseUninstallRestoreArguments(args) {
  if (!Array.isArray(args) || args.length !== 4) throw new Error("INVALID_ARGUMENTS: absolute --user-data and --result-file are required");
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--user-data', '--result-file'].includes(name) || values[name] || !isAbsolute(args[index + 1] ?? ""))
      throw new Error("INVALID_ARGUMENTS: paths must be absolute");
    values[name] = resolve(args[index + 1]);
  }
  if (!values['--user-data'] || !values['--result-file']) throw new Error("INVALID_ARGUMENTS: required paths are missing");
  return { userData: values['--user-data'], resultFile: values['--result-file'] };
}

export async function writeUninstallRestoreResult({ resultFile, result }) {
  if (!isAbsolute(resultFile)) throw new Error("result file must be absolute");
  const path = resolve(resultFile), directory = dirname(path), temporary = join(directory, `.olivia-uninstall-result-${randomUUID()}.tmp`);
  const safeCodes = new Set(["GAME_RUNNING", "STEAM_RUNNING", "BACKUP_INVALID", "PATH_INVALID", "TARGET_CHANGED", "RESTORE_FAILED"]);
  const resultText = result?.success ? "OK" : safeCodes.has(result?.code) ? result.code : "RESTORE_FAILED";
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(resultText, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options;
  try {
    options = parseUninstallRestoreArguments(process.argv.slice(2));
    const result = { success: true, ...(await restoreAllClientPatches({ userData: options.userData })) };
    await writeUninstallRestoreResult({ resultFile: options.resultFile, result });
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = classifyRestoreError(error);
    if (options?.resultFile) {
      try { await writeUninstallRestoreResult({ resultFile: options.resultFile, result }); }
      catch { /* The stable stderr code remains available to the uninstaller log. */ }
    }
    console.error(JSON.stringify({ success: false, code: result.code }));
    process.exitCode = 1;
  }
}
