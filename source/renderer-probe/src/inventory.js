import { opendir, readFile, lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parseAppManifest } from "./steam-vdf.js";

function isInside(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !pathRelative.includes(`..${sep}`));
}

function warningFor(path, error) {
  return `${path}: ${error?.code ?? error?.message ?? "access_error"}`;
}

async function walkFiles(root, onFile, warnings) {
  const boundedRoot = resolve(root);
  let rootStats;
  try {
    rootStats = await lstat(boundedRoot);
  } catch (error) {
    warnings.push(warningFor(boundedRoot, error));
    return;
  }
  if (rootStats.isSymbolicLink()) {
    warnings.push(`${boundedRoot}: skipped symbolic link`);
    return;
  }
  if (!rootStats.isDirectory()) {
    warnings.push(`${boundedRoot}: not a directory`);
    return;
  }

  async function descend(directory) {
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      warnings.push(warningFor(directory, error));
      return;
    }
    try {
      const entries = [];
      for await (const entry of handle) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (!isInside(boundedRoot, entryPath)) {
          warnings.push(`${entryPath}: skipped path outside root`);
          continue;
        }
        if (entry.isSymbolicLink()) {
          warnings.push(`${entryPath}: skipped symbolic link`);
          continue;
        }
        if (entry.isDirectory()) await descend(entryPath);
        else if (entry.isFile()) await onFile(entryPath);
      }
    } catch (error) {
      warnings.push(warningFor(directory, error));
    }
  }

  await descend(boundedRoot);
}

export async function scanRendererInventory({ roots, steamAppsRoot, marker }) {
  const candidates = [];
  const markerHits = [];
  const warnings = [];
  const sortedRoots = [...roots].sort();

  for (const root of sortedRoots) {
    await walkFiles(root, async file => {
      const normalized = file.replaceAll("/", "\\");
      if (/TPRender\\Binaries\\Win64\\Olivia\.exe$/iu.test(normalized)) candidates.push(file);
      if (/version\.json$/iu.test(normalized)) {
        try {
          if ((await readFile(file, "utf8")).includes(marker)) markerHits.push(file);
        } catch (error) {
          warnings.push(warningFor(file, error));
        }
      }
    }, warnings);
  }

  const manifestPath = join(steamAppsRoot, "appmanifest_4532590.acf");
  const steam = parseAppManifest(await readFile(manifestPath, "utf8"));
  return {
    roots: sortedRoots,
    steam,
    candidates: candidates.sort(),
    markerHits: markerHits.sort(),
    warnings: warnings.sort(),
  };
}
