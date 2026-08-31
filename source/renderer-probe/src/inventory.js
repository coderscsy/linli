import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parseAppManifest } from "./steam-vdf.js";

const DEFAULT_FS = { lstat, opendir, readFile, realpath };

function isInside(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !pathRelative.includes(`..${sep}`));
}

function addWarning(warnings, code) {
  // OS messages and scanned names could contain sensitive values; retain only fixed error codes.
  warnings.push(`scan: ${code}`);
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function matchesKind(stats, kind) {
  return kind === "directory" ? stats.isDirectory() : stats.isFile();
}

async function stablePath(path, kind, canonicalRoot, fsAdapter, warnings) {
  async function snapshot() {
    const stats = await fsAdapter.lstat(path);
    if (stats.isSymbolicLink()) return { code: "skipped symbolic link" };
    if (!matchesKind(stats, kind)) return { code: `changed ${kind} type` };
    const canonical = await fsAdapter.realpath(path);
    if (!isInside(canonicalRoot, canonical)) return { code: "skipped path outside root" };
    return { canonical };
  }

  try {
    const before = await snapshot();
    if (before.code) {
      addWarning(warnings, before.code);
      return undefined;
    }
    const after = await snapshot();
    if (after.code || !samePath(before.canonical, after.canonical)) {
      addWarning(warnings, after.code ?? "changed during check");
      return undefined;
    }
    return after.canonical;
  } catch (error) {
    addWarning(warnings, `access ${error?.code ?? "error"}`);
    return undefined;
  }
}

async function canonicalRootFor(root, fsAdapter, warnings) {
  const absoluteRoot = resolve(root);
  try {
    const firstStats = await fsAdapter.lstat(absoluteRoot);
    if (firstStats.isSymbolicLink()) {
      addWarning(warnings, "skipped symbolic link");
      return undefined;
    }
    if (!firstStats.isDirectory()) {
      addWarning(warnings, "root is not a directory");
      return undefined;
    }
    const firstCanonical = await fsAdapter.realpath(absoluteRoot);
    const secondStats = await fsAdapter.lstat(absoluteRoot);
    const secondCanonical = await fsAdapter.realpath(absoluteRoot);
    if (secondStats.isSymbolicLink() || !secondStats.isDirectory() || !samePath(firstCanonical, secondCanonical)) {
      addWarning(warnings, "root changed during check");
      return undefined;
    }
    return secondCanonical;
  } catch (error) {
    addWarning(warnings, `access ${error?.code ?? "error"}`);
    return undefined;
  }
}

async function walkFiles(root, onFile, warnings, fsAdapter) {
  const canonicalRoot = await canonicalRootFor(root, fsAdapter, warnings);
  if (!canonicalRoot) return;

  async function descend(directory) {
    const beforeOpen = await stablePath(directory, "directory", canonicalRoot, fsAdapter, warnings);
    if (!beforeOpen) return;
    let handle;
    try {
      handle = await fsAdapter.opendir(directory);
    } catch (error) {
      addWarning(warnings, `access ${error?.code ?? "error"}`);
      return;
    }
    const afterOpen = await stablePath(directory, "directory", canonicalRoot, fsAdapter, warnings);
    if (!afterOpen || !samePath(beforeOpen, afterOpen)) {
      addWarning(warnings, "directory changed during open");
      await handle.close().catch(() => {});
      return;
    }
    try {
      const entries = [];
      for await (const entry of handle) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          addWarning(warnings, "skipped symbolic link");
          continue;
        }
        if (entry.isDirectory()) await descend(entryPath);
        else if (entry.isFile()) {
          const canonical = await stablePath(entryPath, "file", canonicalRoot, fsAdapter, warnings);
          if (canonical) await onFile(entryPath, canonical, () => stablePath(entryPath, "file", canonicalRoot, fsAdapter, warnings));
        }
      }
    } catch (error) {
      addWarning(warnings, `access ${error?.code ?? "error"}`);
    }
  }

  await descend(canonicalRoot);
}

async function readStableUtf8(file, initialCanonical, revalidate, fsAdapter, warnings) {
  try {
    const contents = await fsAdapter.readFile(file, "utf8");
    const afterRead = await revalidate();
    if (!afterRead || !samePath(initialCanonical, afterRead)) {
      addWarning(warnings, "file changed during read");
      return undefined;
    }
    return contents;
  } catch (error) {
    addWarning(warnings, `access ${error?.code ?? "error"}`);
    return undefined;
  }
}

export async function scanRendererInventory({ roots, steamAppsRoot, marker, fsAdapter = DEFAULT_FS }) {
  const candidates = [];
  const markerHits = [];
  const warnings = [];
  const sortedRoots = [...roots].sort();

  for (const root of sortedRoots) {
    await walkFiles(root, async (file, canonical, revalidate) => {
      const normalized = file.replaceAll("/", "\\");
      if (/TPRender\\Binaries\\Win64\\Olivia\.exe$/iu.test(normalized)) {
        if (await revalidate()) candidates.push(file);
      }
      if (/version\.json$/iu.test(normalized)) {
        const contents = await readStableUtf8(file, canonical, revalidate, fsAdapter, warnings);
        if (contents?.includes(marker)) markerHits.push(file);
      }
    }, warnings, fsAdapter);
  }

  const manifestPath = join(steamAppsRoot, "appmanifest_4532590.acf");
  const steam = parseAppManifest(await fsAdapter.readFile(manifestPath, "utf8"));
  return {
    roots: sortedRoots,
    steam,
    candidates: candidates.sort(),
    markerHits: markerHits.sort(),
    warnings: warnings.sort(),
  };
}
