import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { buildPlayerUploadManifest } from "../local-service/midi/catalog-manifest.js";

const [, , musicArgument, catalogArgument, manifestArgument, backupArgument, groupArgument, modeArgument] = process.argv;
if (!musicArgument || !catalogArgument || !manifestArgument || !groupArgument) {
  console.error("Usage: node apply-verified-catalog-bindings.mjs <music-root> <catalog-root> <manifest> <backup-dir> <group> [--apply]");
  process.exitCode = 2;
} else {
  const musicRoot = resolve(musicArgument);
  const catalogRoot = resolve(catalogArgument);
  const manifestPath = resolve(manifestArgument);
  const backupRoot = resolve(backupArgument || join(dirname(manifestPath), "Backups"));
  const selectedGroup = String(groupArgument).normalize("NFKC");
  const apply = modeArgument === "--apply";
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const generated = await buildPlayerUploadManifest({ musicRoot, catalogRoot });

  const directoryKey = song => {
    const relativePath = song?.variants?.DEFAULT ?? Object.values(song?.variants ?? {})[0];
    return relativePath ? dirname(String(relativePath).replaceAll("\\", "/")) : null;
  };
  const groupOf = song => String(song?.variants?.DEFAULT ?? Object.values(song?.variants ?? {})[0] ?? "")
    .replaceAll("\\", "/")
    .split("/", 1)[0]
    .normalize("NFKC");
  const replacements = new Map(
    generated.songs.filter(song => groupOf(song) === selectedGroup).map(song => [directoryKey(song), song]),
  );
  const missing = [];
  const songs = current.songs.map(song => {
    if (groupOf(song) !== selectedGroup) return song;
    const replacement = replacements.get(directoryKey(song));
    if (!replacement) {
      missing.push(directoryKey(song));
      return song;
    }
    replacements.delete(directoryKey(song));
    return replacement;
  });
  if (missing.length || replacements.size) {
    throw new Error(`Refused partial update: missing current=${missing.length}, unmatched generated=${replacements.size}`);
  }

  const merged = { ...current, songs };
  const changed = songs.filter((song, index) => song.name !== current.songs[index]?.name);
  const verified = songs.filter(song => groupOf(song) === selectedGroup && /【[^】]+ · [A-Z0-9]+】$/u.test(song.name));
  const fallback = songs.filter(song => groupOf(song) === selectedGroup && !/【[^】]+ · [A-Z0-9]+】$/u.test(song.name));
  const previewPath = join(dirname(manifestPath), `${basename(manifestPath, ".json")}.verified.preview.json`);
  await writeFile(previewPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  const summary = {
    group: selectedGroup,
    currentSongs: current.songs.length,
    changed: changed.length,
    verified: verified.length,
    fallback: fallback.length,
    previewPath,
    applied: false,
  };
  if (apply) {
    await mkdir(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupPath = join(backupRoot, `${basename(manifestPath)}.before-verified-bindings-${stamp}.bak`);
    await copyFile(manifestPath, backupPath);
    const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    await rename(temporaryPath, manifestPath);
    summary.applied = true;
    summary.backupPath = backupPath;
  }
  console.log(JSON.stringify(summary, null, 2));
}
