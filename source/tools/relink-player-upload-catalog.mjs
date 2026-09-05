import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildCatalogRelinkPlan } from "../local-service/midi/catalog-relink.js";

const [, , databaseArgument, musicArgument, manifestArgument, backupArgument, modeArgument] = process.argv;
if (!databaseArgument || !musicArgument || !manifestArgument) {
  console.error("Usage: node relink-player-upload-catalog.mjs <database> <music-root> <manifest> [backup-dir] [--apply]");
  process.exitCode = 2;
} else {
  const databasePath = resolve(databaseArgument);
  const musicRoot = resolve(musicArgument);
  const manifestPath = resolve(manifestArgument);
  const backupRoot = resolve(backupArgument || join(dirname(databasePath), "..", "Backups"));
  const apply = modeArgument === "--apply";
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.songs)) throw new Error("Manifest must contain a songs array");

  const readRows = database => database.prepare(`
    SELECT id, name, video_path
    FROM user_songs
    WHERE source_kind IN ('import', 'official-import') AND job_id IS NULL
    ORDER BY id
  `).all();

  let database = new DatabaseSync(databasePath, { readOnly: !apply });
  const beforeCheck = database.prepare("PRAGMA quick_check").all().map(row => row.quick_check);
  if (beforeCheck.length !== 1 || beforeCheck[0] !== "ok") throw new Error(`Database quick_check failed: ${beforeCheck.join(", ")}`);
  const rows = readRows(database);
  const plan = buildCatalogRelinkPlan({ rows, songs: manifest.songs, musicRoot });
  const summary = {
    databasePath,
    manifestPath,
    databaseSongs: rows.length,
    manifestSongs: manifest.songs.length,
    changed: plan.updates.length,
    unmatchedRows: plan.unmatchedRows.length,
    unmatchedManifest: plan.unmatchedManifest.length,
    examples: plan.updates.slice(0, 12),
    applied: false,
  };

  if (!apply) {
    database.close();
    console.log(JSON.stringify(summary, null, 2));
  } else {
    if (plan.unmatchedRows.length || plan.unmatchedManifest.length || rows.length !== manifest.songs.length) {
      database.close();
      throw new Error("Relink refused because the database and manifest are not a complete one-to-one match");
    }

    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    await mkdir(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupPath = join(backupRoot, `${basename(databasePath)}.before-catalog-relink-${stamp}.bak`);
    await copyFile(databasePath, backupPath);

    database = new DatabaseSync(databasePath);
    const update = database.prepare("UPDATE user_songs SET name = ?, name_key = ?, updated_at = ? WHERE id = ?");
    const now = Math.floor(Date.now() / 1000);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of plan.updates) {
        const nameKey = item.after.normalize("NFKC").toLocaleLowerCase();
        const result = update.run(item.after, nameKey, now, item.id);
        if (Number(result.changes) !== 1) throw new Error(`Song disappeared during relink: ${item.id}`);
      }
      database.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }

    const afterCheck = database.prepare("PRAGMA quick_check").all().map(row => row.quick_check);
    const verification = buildCatalogRelinkPlan({ rows: readRows(database), songs: manifest.songs, musicRoot });
    database.close();
    if (afterCheck.length !== 1 || afterCheck[0] !== "ok") throw new Error(`Database quick_check failed after relink: ${afterCheck.join(", ")}`);
    if (verification.updates.length || verification.unmatchedRows.length || verification.unmatchedManifest.length) {
      throw new Error("Database verification failed after relink");
    }
    console.log(JSON.stringify({ ...summary, applied: true, backupPath }, null, 2));
  }
}
