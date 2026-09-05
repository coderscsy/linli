import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { checkMigrationCapacity, storageDirectories } from "./storage-paths.js";

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function migrationError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function parseVariants(row) {
  try {
    const value = JSON.parse(row.video_by_tod_view || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function createStorageMigrationManager({
  db,
  midiStore,
  now = () => Math.floor(Date.now() / 1000),
  randomToken = randomUUID,
  hashFile = sha256File,
  statImpl = stat,
  statfsImpl = path => statfs(path, { bigint: true }),
  copyFileImpl = copyFile,
  renameImpl = rename,
  tokenLifetimeSeconds = 10 * 60,
} = {}) {
  if (!db || !midiStore) throw new TypeError("storage migration requires db and midiStore");
  const previews = new Map();
  const previewJobs = new Map();
  let activePreviewJobId = null;

  async function buildOperations(targetRoot, { onProgress = () => {}, isCancelled = () => false } = {}) {
    const directories = storageDirectories(targetRoot);
    const sources = new Map();
    const rows = db.prepare(`
      SELECT * FROM user_songs WHERE source_kind <> 'upload' AND job_id IS NULL ORDER BY rowid
    `).all();
    for (const row of rows) {
      const variants = parseVariants(row);
      const storedPaths = new Set([row.video_path, ...Object.values(variants)].filter(Boolean));
      for (const storedPath of storedPaths) {
        const source = midiStore.resolvePath(storedPath);
        let info;
        try {
          info = await statImpl(source);
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        const key = resolve(source);
        if (!sources.has(key)) {
          sources.set(key, {
            source,
            size: Number(info.size),
            mtimeMs: Number(info.mtimeMs),
          });
        }
      }
    }
    const discovered = [...sources.values()];
    onProgress({ phase: "hashing", processedFiles: 0, totalFiles: discovered.length, processedBytes: 0 });
    const operations = [];
    let processedBytes = 0;
    for (let index = 0; index < discovered.length; index += 1) {
      if (isCancelled()) throw migrationError("MIGRATION_PREVIEW_CANCELLED", "迁移预览已取消");
      const item = discovered[index];
      const hash = await hashFile(item.source);
      if (isCancelled()) throw migrationError("MIGRATION_PREVIEW_CANCELLED", "迁移预览已取消");
      const extension = extname(item.source).toLowerCase() || ".mp4";
      const destination = join(directories.performances, ".media", `${hash}${extension}`);
      let ready = false;
      try {
        ready = await hashFile(destination) === hash;
      } catch {
        ready = false;
      }
      operations.push({ ...item, hash, destination, copy: !ready });
      processedBytes += item.size;
      onProgress({
        phase: "hashing",
        processedFiles: index + 1,
        totalFiles: discovered.length,
        processedBytes,
      });
    }
    const requiredBytes = operations.filter(item => item.copy)
      .reduce((total, item) => total + item.size, 0);
    const disk = await statfsImpl(targetRoot);
    const rawFree = BigInt(disk.bavail) * BigInt(disk.bsize);
    const freeBytes = rawFree > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(rawFree);
    return {
      directories,
      rows,
      operations,
      ...checkMigrationCapacity({ requiredBytes, freeBytes }),
    };
  }

  async function preview({ targetRoot, onProgress, isCancelled } = {}) {
    const target = resolve(String(targetRoot ?? ""));
    const built = await buildOperations(target, { onProgress, isCancelled });
    const token = randomToken();
    const expiresAt = now() + tokenLifetimeSeconds;
    previews.set(token, { ...built, targetRoot: target, expiresAt });
    return {
      token,
      expiresAt,
      targetRoot: target,
      files: built.operations.length,
      totalBytes: built.requiredBytes,
      freeBytes: built.freeBytes,
      reserveBytes: built.reserveBytes,
      totalRequiredBytes: built.totalRequiredBytes,
      shortfallBytes: built.shortfallBytes,
      sufficient: built.sufficient,
    };
  }

  function publicPreviewJob(job) {
    if (!job) return null;
    return {
      jobId: job.jobId,
      state: job.state,
      phase: job.phase,
      processedFiles: job.processedFiles,
      totalFiles: job.totalFiles,
      processedBytes: job.processedBytes,
      token: job.token,
      expiresAt: job.expiresAt,
      targetRoot: job.targetRoot,
      files: job.files,
      totalBytes: job.totalBytes,
      freeBytes: job.freeBytes,
      reserveBytes: job.reserveBytes,
      totalRequiredBytes: job.totalRequiredBytes,
      shortfallBytes: job.shortfallBytes,
      sufficient: job.sufficient,
      error: job.error,
    };
  }

  function cancelPreview(jobId) {
    const job = previewJobs.get(String(jobId ?? ""));
    if (!job) throw migrationError("MIGRATION_PREVIEW_JOB_NOT_FOUND", "迁移预览任务不存在");
    if (job.state === "scanning") {
      job.cancelRequested = true;
      job.state = "cancelled";
      job.phase = "cancelled";
      if (job.token) previews.delete(job.token);
      job.token = null;
    }
    if (activePreviewJobId === job.jobId) activePreviewJobId = null;
    return publicPreviewJob(job);
  }

  function startPreview({ targetRoot }) {
    if (activePreviewJobId) {
      const active = previewJobs.get(activePreviewJobId);
      if (active?.state === "scanning") cancelPreview(activePreviewJobId);
    }
    const jobId = randomToken();
    const job = {
      jobId,
      state: "scanning",
      phase: "discovering",
      processedFiles: 0,
      totalFiles: 0,
      processedBytes: 0,
      token: null,
      expiresAt: null,
      targetRoot: resolve(String(targetRoot ?? "")),
      files: 0,
      totalBytes: 0,
      freeBytes: 0,
      reserveBytes: 0,
      totalRequiredBytes: 0,
      shortfallBytes: 0,
      sufficient: false,
      error: null,
      cancelRequested: false,
    };
    previewJobs.set(jobId, job);
    activePreviewJobId = jobId;
    Promise.resolve().then(async () => {
      try {
        const result = await preview({
          targetRoot: job.targetRoot,
          isCancelled: () => job.cancelRequested,
          onProgress: progress => {
            if (!job.cancelRequested) Object.assign(job, progress);
          },
        });
        if (job.cancelRequested) {
          previews.delete(result.token);
          return;
        }
        Object.assign(job, result, { state: "ready", phase: "ready", error: null });
      } catch (error) {
        if (job.cancelRequested || error.code === "MIGRATION_PREVIEW_CANCELLED") {
          job.state = "cancelled";
          job.phase = "cancelled";
          job.token = null;
        } else {
          job.state = "failed";
          job.phase = "failed";
          job.error = error.message;
        }
      } finally {
        if (activePreviewJobId === jobId) activePreviewJobId = null;
      }
    });
    return publicPreviewJob(job);
  }

  function getPreview(jobId) {
    const job = previewJobs.get(String(jobId ?? ""));
    if (!job) throw migrationError("MIGRATION_PREVIEW_JOB_NOT_FOUND", "迁移预览任务不存在");
    return publicPreviewJob(job);
  }

  async function confirm({ token, confirmed }) {
    if (confirmed !== true) throw migrationError("MIGRATION_CONFIRMATION_REQUIRED", "迁移必须由用户明确确认");
    const saved = previews.get(String(token ?? ""));
    if (!saved) throw migrationError("MIGRATION_PREVIEW_NOT_FOUND", "迁移预览不存在或已过期");
    if (now() > saved.expiresAt) {
      previews.delete(String(token));
      throw migrationError("MIGRATION_PREVIEW_EXPIRED", "迁移预览已过期，请重新预览");
    }
    if (!saved.sufficient) throw migrationError("MIGRATION_INSUFFICIENT_SPACE", "目标磁盘空间不足，未复制任何视频", saved);

    for (const operation of saved.operations) {
      const current = await statImpl(operation.source);
      if (Number(current.size) !== operation.size || Number(current.mtimeMs) !== operation.mtimeMs)
        throw migrationError("MIGRATION_SOURCE_CHANGED", "源视频已变化，请重新预览");
    }

    const staging = join(saved.directories.staging, `migration-${randomToken()}`);
    try {
      for (const operation of saved.operations.filter(item => item.copy)) {
        const staged = join(staging, `${operation.hash}${extname(operation.destination)}`);
        await mkdir(join(staging), { recursive: true });
        await copyFileImpl(operation.source, staged);
        if (await hashFile(staged) !== operation.hash)
          throw migrationError("MIGRATION_HASH_MISMATCH", "迁移视频校验失败，数据库未切换");
        await mkdir(resolve(operation.destination, ".."), { recursive: true });
        try {
          await renameImpl(staged, operation.destination);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }

      const destinations = new Map(saved.operations.map(item => [resolve(item.source), item.destination]));
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare(`
          UPDATE user_songs SET video_path = ?, video_by_tod_view = ?, updated_at = ? WHERE id = ?
        `);
        for (const row of saved.rows) {
          const variants = parseVariants(row);
          const migratedVariants = Object.fromEntries(Object.entries(variants).map(([key, storedPath]) => {
            const destination = destinations.get(resolve(midiStore.resolvePath(storedPath)));
            return [key, destination ? midiStore.encodePath(destination, { externalRoot: saved.targetRoot }) : storedPath];
          }));
          const primaryDestination = destinations.get(resolve(midiStore.resolvePath(row.video_path)));
          update.run(
            primaryDestination ? midiStore.encodePath(primaryDestination, { externalRoot: saved.targetRoot }) : row.video_path,
            JSON.stringify(migratedVariants),
            now(),
            row.id,
          );
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_library_meta'").get())
          db.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
        const quick = db.prepare("PRAGMA quick_check").get().quick_check;
        if (quick !== "ok") throw migrationError("MIGRATION_DATABASE_CHECK_FAILED", `迁移后数据库检查失败：${quick}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      previews.delete(String(token));
      return { migrated: saved.rows.length, skipped: saved.operations.filter(item => !item.copy).length, targetRoot: saved.targetRoot };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return { preview, startPreview, getPreview, cancelPreview, confirm };
}
