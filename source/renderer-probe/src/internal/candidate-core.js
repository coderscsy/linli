import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_FS = { createReadStream, lstat, readdir, realpath };

function comparePath(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function isInside(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !pathRelative.includes(`..${sep}`));
}
function relativeDisplay(root, path) { return relative(root, path).split(sep).join("/"); }
function fixedResult(status, missing = [], files = [], totalBytes = 0) {
  return {
    status,
    rendererRoot: "<candidate>/TPRender",
    executable: "<candidate>/TPRender/Binaries/Win64/Olivia.exe",
    files,
    missing: [...new Set(missing)].sort(comparePath),
    totalBytes,
  };
}

async function stablePath(path, kind, canonicalRoot, fsAdapter) {
  async function snapshot() {
    const stats = await fsAdapter.lstat(path);
    if (stats.isSymbolicLink()) return { reason: "candidate contains symbolic link" };
    if ((kind === "directory" && !stats.isDirectory()) || (kind === "file" && !stats.isFile())) return { reason: "candidate changed during validation" };
    const canonical = await fsAdapter.realpath(path);
    if (!isInside(canonicalRoot, canonical)) return { reason: "candidate path escapes renderer root" };
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) return { reason: "candidate changed during validation" };
    return { canonical, size: stats.size };
  }
  try {
    const before = await snapshot();
    if (before.reason) return before;
    const after = await snapshot();
    if (after.reason || !samePath(before.canonical, after.canonical)) return { reason: after.reason ?? "candidate changed during validation" };
    return after;
  } catch {
    return { reason: "candidate access error" };
  }
}

async function stableRoot(root, fsAdapter) {
  try {
    const firstStats = await fsAdapter.lstat(root);
    if (firstStats.isSymbolicLink()) return { reason: "candidate contains symbolic link" };
    if (!firstStats.isDirectory()) return { reason: "candidate changed during validation" };
    const firstCanonical = await fsAdapter.realpath(root);
    const secondStats = await fsAdapter.lstat(root);
    const secondCanonical = await fsAdapter.realpath(root);
    if (secondStats.isSymbolicLink() || !secondStats.isDirectory() || !samePath(firstCanonical, secondCanonical)) return { reason: "candidate changed during validation" };
    return { canonical: secondCanonical };
  } catch {
    return { reason: "candidate access error" };
  }
}

async function collectFiles(root, canonicalRoot, fsAdapter) {
  const files = [];
  let reason;
  async function descend(directory) {
    if (reason) return;
    const stableDirectory = await stablePath(directory, "directory", canonicalRoot, fsAdapter);
    if (stableDirectory.reason) { reason = stableDirectory.reason; return; }
    let entries;
    try {
      entries = await fsAdapter.readdir(directory, { withFileTypes: true });
    } catch {
      reason = "candidate access error";
      return;
    }
    const afterRead = await stablePath(directory, "directory", canonicalRoot, fsAdapter);
    if (afterRead.reason || !samePath(stableDirectory.canonical, afterRead.canonical)) { reason = afterRead.reason ?? "candidate changed during validation"; return; }
    entries.sort((left, right) => comparePath(left.name, right.name));
    for (const entry of entries) {
      if (reason) return;
      const entryPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) { reason = "candidate contains symbolic link"; return; }
      if (entry.isDirectory()) await descend(entryPath);
      else if (entry.isFile()) {
        const stableFile = await stablePath(entryPath, "file", canonicalRoot, fsAdapter);
        if (stableFile.reason) { reason = stableFile.reason; return; }
        files.push({ path: entryPath, canonical: stableFile.canonical });
        if (files.length > MAX_FILES) { reason = "candidate file limit exceeded"; return; }
      } else { reason = "candidate contains unsupported entry"; return; }
    }
  }
  await descend(root);
  return { files, reason };
}

async function hashStableFile(file, canonical, canonicalRoot, fsAdapter) {
  const before = await stablePath(file, "file", canonicalRoot, fsAdapter);
  if (before.reason || !samePath(before.canonical, canonical)) return { reason: before.reason ?? "candidate changed during validation" };
  if (before.size > MAX_TOTAL_BYTES) return { reason: "candidate byte limit exceeded" };
  const hash = createHash("sha256");
  let size = 0;
  let header = Buffer.alloc(0);
  try {
    await new Promise((resolveStream, rejectStream) => {
      const stream = fsAdapter.createReadStream(file);
      stream.on("data", chunk => {
        size += chunk.length;
        hash.update(chunk);
        if (header.length < 2) header = Buffer.concat([header, chunk.subarray(0, 2 - header.length)]);
      });
      stream.once("error", rejectStream);
      stream.once("end", resolveStream);
    });
  } catch {
    return { reason: "candidate access error" };
  }
  if (size > MAX_TOTAL_BYTES) return { reason: "candidate byte limit exceeded" };
  const after = await stablePath(file, "file", canonicalRoot, fsAdapter);
  if (after.reason || !samePath(after.canonical, canonical)) return { reason: after.reason ?? "candidate changed during validation" };
  return { size, sha256: hash.digest("hex"), hasMz: header[0] === 0x4d && header[1] === 0x5a };
}

function hasExpectedSuffix(executable, rendererRoot) {
  return basename(executable).toLowerCase() === "olivia.exe"
    && basename(dirname(executable)).toLowerCase() === "win64"
    && basename(dirname(dirname(executable))).toLowerCase() === "binaries"
    && basename(rendererRoot).toLowerCase() === "tprender";
}

export async function validateRendererCandidateWithFs(executablePath, fsAdapter = DEFAULT_FS) {
  const executable = resolve(executablePath);
  const rendererRoot = dirname(dirname(dirname(executable)));
  if (!hasExpectedSuffix(executable, rendererRoot)) return fixedResult("invalid_pe", ["TPRender/Binaries/Win64/Olivia.exe"]);

  const rootState = await stableRoot(rendererRoot, fsAdapter);
  if (rootState.reason) return fixedResult("incomplete", [rootState.reason]);
  const executableState = await stablePath(executable, "file", rootState.canonical, fsAdapter);
  if (executableState.reason) return fixedResult("incomplete", [executableState.reason]);
  const collected = await collectFiles(rendererRoot, rootState.canonical, fsAdapter);
  if (collected.reason) return fixedResult("incomplete", [collected.reason]);

  const hashed = [];
  let totalBytes = 0;
  for (const file of collected.files.sort((left, right) => comparePath(relativeDisplay(rootState.canonical, left.canonical), relativeDisplay(rootState.canonical, right.canonical)))) {
    const currentRoot = await stableRoot(rendererRoot, fsAdapter);
    if (currentRoot.reason || !samePath(currentRoot.canonical, rootState.canonical)) {
      return fixedResult("incomplete", [currentRoot.reason ?? "candidate changed during validation"]);
    }
    const value = await hashStableFile(file.path, file.canonical, rootState.canonical, fsAdapter);
    if (value.reason) return fixedResult("incomplete", [value.reason]);
    totalBytes += value.size;
    if (totalBytes > MAX_TOTAL_BYTES) return fixedResult("incomplete", ["candidate byte limit exceeded"]);
    hashed.push({ path: relativeDisplay(rootState.canonical, file.canonical), ...value });
  }

  const missing = [];
  const executableFile = hashed.find(file => file.path === "Binaries/Win64/Olivia.exe");
  if (!executableFile) missing.push("Binaries/Win64/Olivia.exe");
  else if (!executableFile.hasMz) missing.push("Binaries/Win64/Olivia.exe:MZ");
  const dlls = hashed.filter(file => file.path.startsWith("Binaries/Win64/") && file.path.toLowerCase().endsWith(".dll"));
  if (dlls.length === 0) missing.push("Binaries/Win64/*.dll");
  for (const dll of dlls) if (!dll.hasMz) missing.push(`${dll.path}:MZ`);
  if (!hashed.some(file => file.path.startsWith("Content/Paks/") && file.path.toLowerCase().endsWith(".pak"))) missing.push("Content/Paks/*.pak");
  if (!hashed.some(file => file.path.startsWith("Config/") && file.path.toLowerCase().endsWith(".ini"))) missing.push("Config/*.ini");
  const invalidPe = missing.some(item => item.endsWith(":MZ"));
  return fixedResult(invalidPe ? "invalid_pe" : missing.length ? "incomplete" : "complete", missing, hashed.map(({ hasMz, ...file }) => file), totalBytes);
}
