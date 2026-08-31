import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

const DEFAULT_LIMITS = Object.freeze({ maxFiles: 10_000, maxTotalBytes: 16 * 1024 * 1024 * 1024 });
const DEFAULT_FS = { lstat, open, readdir, realpath, openFlags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) };
function comparePath(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function isInside(root, path) { const value = relative(root, path); return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !value.includes(`..${sep}`)); }
function relativeDisplay(root, path) {
  const names = relative(root, path).split(sep);
  const canonical = new Map([["binaries", "Binaries"], ["win64", "Win64"], ["content", "Content"], ["paks", "Paks"], ["config", "Config"], ["olivia.exe", "Olivia.exe"]]);
  return names.map(name => canonical.get(name.toLowerCase()) ?? name).join("/");
}
function pathKey(path) { return path.toLowerCase(); }
function fixedResult(status, missing = [], files = [], totalBytes = 0) { return { status, rendererRoot: "<candidate>/TPRender", executable: "<candidate>/TPRender/Binaries/Win64/Olivia.exe", files, missing: [...new Set(missing)].sort(comparePath), totalBytes }; }
function safeStats(stats) { return Number.isSafeInteger(stats.size) && stats.size >= 0 && Number.isFinite(stats.mtimeMs); }
function sameIdentity(left, right) {
  if (!left || !right || !safeStats(left) || !safeStats(right) || left.size !== right.size || left.mtimeMs !== right.mtimeMs) return false;
  const inode = Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino) && Number.isSafeInteger(right.dev) && Number.isSafeInteger(right.ino) && (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0);
  return !inode || (left.dev === right.dev && left.ino === right.ino);
}

async function stablePath(path, kind, canonicalRoot, fsAdapter) {
  async function snapshot() {
    const stats = await fsAdapter.lstat(path);
    if (stats.isSymbolicLink()) return { reason: "candidate contains symbolic link" };
    if ((kind === "directory" && !stats.isDirectory()) || (kind === "file" && !stats.isFile()) || !safeStats(stats)) return { reason: "candidate changed during validation" };
    const canonical = await fsAdapter.realpath(path);
    if (!isInside(canonicalRoot, canonical)) return { reason: "candidate path escapes renderer root" };
    return { canonical, stats };
  }
  try {
    const before = await snapshot();
    if (before.reason) return before;
    const after = await snapshot();
    if (after.reason || !samePath(before.canonical, after.canonical) || !sameIdentity(before.stats, after.stats)) return { reason: after.reason ?? "candidate changed during validation" };
    return after;
  } catch { return { reason: "candidate access error" }; }
}

async function stableRoot(root, fsAdapter) {
  const state = await stablePath(root, "directory", resolve(root), fsAdapter);
  return state.reason ? state : { canonical: state.canonical, stats: state.stats };
}

async function collectFiles(root, canonicalRoot, fsAdapter, maxFiles) {
  const files = [];
  let reason;
  async function descend(directory) {
    if (reason) return;
    const before = await stablePath(directory, "directory", canonicalRoot, fsAdapter);
    if (before.reason) { reason = before.reason; return; }
    let entries;
    try { entries = await fsAdapter.readdir(directory, { withFileTypes: true }); } catch { reason = "candidate access error"; return; }
    const after = await stablePath(directory, "directory", canonicalRoot, fsAdapter);
    if (after.reason || !samePath(before.canonical, after.canonical) || !sameIdentity(before.stats, after.stats)) { reason = after.reason ?? "candidate changed during validation"; return; }
    entries.sort((left, right) => comparePath(left.name.toLowerCase(), right.name.toLowerCase()) || comparePath(left.name, right.name));
    for (const entry of entries) {
      if (reason) return;
      const entryPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) { reason = "candidate contains symbolic link"; return; }
      if (entry.isDirectory()) await descend(entryPath);
      else if (entry.isFile()) {
        const state = await stablePath(entryPath, "file", canonicalRoot, fsAdapter);
        if (state.reason) { reason = state.reason; return; }
        files.push({ path: entryPath, canonical: state.canonical, stats: state.stats });
        if (files.length > maxFiles) { reason = "candidate file limit exceeded"; return; }
      } else reason = "candidate contains unsupported entry";
    }
  }
  await descend(root);
  return { files, reason };
}

async function openReadonlyNoFollow(path, fsAdapter) {
  const flags = fsAdapter.openFlags ?? DEFAULT_FS.openFlags;
  const readonlyFlags = fsAdapter.readOnlyFlags ?? constants.O_RDONLY;
  try { return await fsAdapter.open(path, flags); }
  catch (error) {
    if (flags !== readonlyFlags && ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) return fsAdapter.open(path, readonlyFlags);
    throw error;
  }
}

async function openVerifiedFile(file, canonicalRoot, fsAdapter) {
  const before = await stablePath(file.path, "file", canonicalRoot, fsAdapter);
  if (before.reason || !samePath(before.canonical, file.canonical) || !sameIdentity(before.stats, file.stats)) return { reason: before.reason ?? "candidate changed during validation" };
  let handle;
  try {
    handle = await openReadonlyNoFollow(file.path, fsAdapter);
    const handleStats = await handle.stat();
    const after = await stablePath(file.path, "file", canonicalRoot, fsAdapter);
    if (after.reason || !samePath(after.canonical, file.canonical) || !sameIdentity(before.stats, handleStats) || !sameIdentity(before.stats, after.stats) || !sameIdentity(handleStats, after.stats)) {
      await handle.close().catch(() => {});
      return { reason: after.reason ?? "candidate changed during validation" };
    }
    return { handle, stats: handleStats };
  } catch {
    await handle?.close().catch(() => {});
    return { reason: "candidate access error" };
  }
}

async function hashOpenFile(file, canonicalRoot, remainingBytes, fsAdapter) {
  const opened = await openVerifiedFile(file, canonicalRoot, fsAdapter);
  if (opened.reason) return opened;
  if (opened.stats.size > remainingBytes) { await opened.handle.close().catch(() => {}); return { reason: "candidate byte limit exceeded" }; }
  const hash = createHash("sha256");
  let size = 0;
  let header = Buffer.alloc(0);
  let exceeded = false;
  try {
    await new Promise((resolveStream, rejectStream) => {
      const stream = opened.handle.createReadStream({ autoClose: false, highWaterMark: Math.max(1, Math.min(64 * 1024, remainingBytes)) });
      stream.on("data", chunk => {
        if (size + chunk.length > remainingBytes) { exceeded = true; stream.destroy(); return; }
        size += chunk.length;
        hash.update(chunk);
        if (header.length < 2) header = Buffer.concat([header, chunk.subarray(0, 2 - header.length)]);
      });
      stream.once("error", error => { if (exceeded) resolveStream(); else rejectStream(error); });
      stream.once("end", resolveStream);
      stream.once("close", () => { if (exceeded) resolveStream(); });
    });
    if (exceeded) return { reason: "candidate byte limit exceeded" };
    const handleAfter = await opened.handle.stat();
    const pathAfter = await stablePath(file.path, "file", canonicalRoot, fsAdapter);
    if (pathAfter.reason || !sameIdentity(opened.stats, handleAfter) || !sameIdentity(opened.stats, pathAfter.stats) || !samePath(pathAfter.canonical, file.canonical) || size !== opened.stats.size) return { reason: pathAfter.reason ?? "candidate changed during validation" };
    return { size, sha256: hash.digest("hex"), hasMz: header[0] === 0x4d && header[1] === 0x5a };
  } catch { return { reason: "candidate access error" }; }
  finally { await opened.handle.close().catch(() => {}); }
}

function hasExpectedSuffix(executable, rendererRoot) { return basename(executable).toLowerCase() === "olivia.exe" && basename(dirname(executable)).toLowerCase() === "win64" && basename(dirname(dirname(executable))).toLowerCase() === "binaries" && basename(rendererRoot).toLowerCase() === "tprender"; }
function resolveLimits(limits) {
  const value = { ...DEFAULT_LIMITS, ...limits };
  if (!Number.isSafeInteger(value.maxFiles) || value.maxFiles < 1 || !Number.isSafeInteger(value.maxTotalBytes) || value.maxTotalBytes < 1) throw new TypeError("invalid limits");
  return value;
}

export async function validateRendererCandidateWithFs(executablePath, fsAdapter = DEFAULT_FS, limits) {
  const { maxFiles, maxTotalBytes } = resolveLimits(limits);
  const executable = resolve(executablePath);
  const rendererRoot = dirname(dirname(dirname(executable)));
  if (!hasExpectedSuffix(executable, rendererRoot)) return fixedResult("invalid_pe", ["TPRender/Binaries/Win64/Olivia.exe"]);
  const rootState = await stableRoot(rendererRoot, fsAdapter);
  if (rootState.reason) return fixedResult("incomplete", [rootState.reason]);
  const executableState = await stablePath(executable, "file", rootState.canonical, fsAdapter);
  if (executableState.reason) return fixedResult("incomplete", [executableState.reason]);
  const collected = await collectFiles(rendererRoot, rootState.canonical, fsAdapter, maxFiles);
  if (collected.reason) return fixedResult("incomplete", [collected.reason]);
  const files = collected.files.sort((left, right) => comparePath(pathKey(relativeDisplay(rootState.canonical, left.canonical)), pathKey(relativeDisplay(rootState.canonical, right.canonical))) || comparePath(relativeDisplay(rootState.canonical, left.canonical), relativeDisplay(rootState.canonical, right.canonical)));
  let plannedBytes = 0;
  for (const file of files) {
    const state = await stablePath(file.path, "file", rootState.canonical, fsAdapter);
    if (state.reason || !samePath(state.canonical, file.canonical) || !sameIdentity(state.stats, file.stats)) return fixedResult("incomplete", [state.reason ?? "candidate changed during validation"]);
    plannedBytes += state.stats.size;
    if (plannedBytes > maxTotalBytes) return fixedResult("incomplete", ["candidate byte limit exceeded"]);
  }
  const hashed = [];
  let totalBytes = 0;
  for (const file of files) {
    const currentRoot = await stableRoot(rendererRoot, fsAdapter);
    if (currentRoot.reason || !samePath(currentRoot.canonical, rootState.canonical) || !sameIdentity(currentRoot.stats, rootState.stats)) return fixedResult("incomplete", [currentRoot.reason ?? "candidate changed during validation"]);
    const value = await hashOpenFile(file, rootState.canonical, maxTotalBytes - totalBytes, fsAdapter);
    if (value.reason) return fixedResult("incomplete", [value.reason]);
    totalBytes += value.size;
    hashed.push({ path: relativeDisplay(rootState.canonical, file.canonical), ...value });
  }
  const missing = [];
  const executableFile = hashed.find(file => pathKey(file.path) === "binaries/win64/olivia.exe");
  if (!executableFile) missing.push("Binaries/Win64/Olivia.exe"); else if (!executableFile.hasMz) missing.push("Binaries/Win64/Olivia.exe:MZ");
  const dlls = hashed.filter(file => pathKey(file.path).startsWith("binaries/win64/") && pathKey(file.path).endsWith(".dll"));
  if (dlls.length === 0) missing.push("Binaries/Win64/*.dll");
  for (const dll of dlls) if (!dll.hasMz) missing.push(`${dll.path}:MZ`);
  if (!hashed.some(file => pathKey(file.path).startsWith("content/paks/") && pathKey(file.path).endsWith(".pak"))) missing.push("Content/Paks/*.pak");
  if (!hashed.some(file => pathKey(file.path).startsWith("config/") && pathKey(file.path).endsWith(".ini"))) missing.push("Config/*.ini");
  const invalidPe = missing.some(item => item.endsWith(":MZ"));
  return fixedResult(invalidPe ? "invalid_pe" : missing.length ? "incomplete" : "complete", missing, hashed.map(({ hasMz, ...file }) => file), totalBytes);
}
