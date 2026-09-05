import { dirname, isAbsolute, resolve, sep } from "node:path";

function absoluteVideoPath(value, musicRoot) {
  const stored = String(value ?? "").trim();
  if (!stored) return null;
  if (stored.startsWith("external:")) return resolve(stored.slice("external:".length));
  if (isAbsolute(stored)) return resolve(stored);
  return resolve(musicRoot, stored.split(/[\\/]/u).join(sep));
}

function directoryKey(value, musicRoot) {
  const absolute = absoluteVideoPath(value, musicRoot);
  return absolute ? dirname(absolute).normalize("NFKC").toLocaleLowerCase() : null;
}

export function buildCatalogRelinkPlan({ rows, songs, musicRoot }) {
  const manifestByDirectory = new Map();
  const duplicateManifestDirectories = [];
  for (const song of songs) {
    const key = directoryKey(song?.variants?.DEFAULT ?? Object.values(song?.variants ?? {})[0], musicRoot);
    if (!key) continue;
    if (manifestByDirectory.has(key)) duplicateManifestDirectories.push(key);
    manifestByDirectory.set(key, song);
  }

  if (duplicateManifestDirectories.length) {
    throw new Error(`Manifest contains duplicate performance directories: ${duplicateManifestDirectories.length}`);
  }

  const matchedDirectories = new Set();
  const updates = [];
  const unmatchedRows = [];
  for (const row of rows) {
    const key = directoryKey(row.video_path, musicRoot);
    const song = key ? manifestByDirectory.get(key) : null;
    if (!song) {
      unmatchedRows.push({ id: row.id, name: row.name, videoPath: row.video_path });
      continue;
    }
    matchedDirectories.add(key);
    if (row.name !== song.name) updates.push({ id: row.id, before: row.name, after: song.name });
  }

  const unmatchedManifest = [];
  for (const [key, song] of manifestByDirectory) {
    if (!matchedDirectories.has(key)) unmatchedManifest.push({ name: song.name, directory: key });
  }

  return { updates, unmatchedRows, unmatchedManifest };
}
