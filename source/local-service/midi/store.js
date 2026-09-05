import { randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { songVariants, TIME_SLOTS } from "./song-metadata.js";

const RUNNING_STATES = ["analyzing", "synthesizing", "rendering", "muxing"];
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const TRANSITIONS = new Map([
  ["queued", new Set(["analyzing", "cancelled"])],
  ["analyzing", new Set(["synthesizing", "failed", "cancelled"])],
  ["synthesizing", new Set(["rendering", "failed", "cancelled"])],
  ["rendering", new Set(["muxing", "failed", "cancelled"])],
  ["muxing", new Set(["completed", "failed", "cancelled"])],
]);

export class MidiStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MidiStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MidiStoreError(code, message);
}

function within(base, candidate) {
  const value = relative(resolve(base), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function slash(value) {
  return value.replaceAll("\\", "/");
}

function safeFilename(value) {
  const original = basename(String(value ?? "upload.mid"));
  const extension = extname(original).toLowerCase();
  const allowedExtension = extension === ".midi" ? ".midi" : ".mid";
  const stem = original.slice(0, Math.max(0, original.length - extension.length))
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "upload";
  return `${stem}${allowedExtension}`;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizePerformanceType(value) {
  const normalized = String(value ?? "").trim().replaceAll(/[_\s-]+/gu, "").toLocaleLowerCase();
  if (normalized === "playsing" || normalized === "弹唱") return "PlaySing";
  if (normalized === "instrumental" || normalized === "伴奏") return "Instrumental";
  return "Solo";
}

function uploadFromRow(row) {
  if (!row) return null;
  return {
    token: row.token,
    key: row.upload_key,
    originalFilename: row.original_filename,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    inputPath: row.input_path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    maxBytes: row.max_bytes,
  };
}

function jobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    uploadKey: row.upload_key,
    title: row.title,
    state: row.state,
    progress: row.progress,
    error: row.error,
    inputPath: row.input_path,
    timelinePath: row.timeline_path,
    audioPath: row.audio_path,
    videoPath: row.video_path,
    durationUs: row.duration_us,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function songFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    name: row.custom_name ?? row.corrected_name ?? row.name,
    originalName: row.name,
    customName: row.custom_name ?? null,
    correctedName: row.corrected_name ?? null,
    timeOfDayMapping: parseJson(row.time_of_day_mapping, null),
    sourceKind: row.source_kind,
    midiPath: row.midi_path,
    videoPath: row.video_path,
    durationUs: row.duration_us,
    contentHash: row.content_hash,
    performanceType: normalizePerformanceType(row.performance_type),
    videoByTodView: parseJson(row.video_by_tod_view, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.created_at, row._rowid]), "utf8").toString("base64url");
}

function decodeCursor(value) {
  const cursor = String(value ?? "").trim();
  if (!cursor || cursor === "0") return null;
  try {
    const [createdAt, rowid] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isFinite(Number(createdAt)) || !Number.isFinite(Number(rowid))) return null;
    return { createdAt: Number(createdAt), rowid: Number(rowid) };
  } catch {
    return null;
  }
}

export class MidiStore {
  constructor({ db, root, now = () => Math.floor(Date.now() / 1000), randomId = randomUUID }) {
    if (!db) throw new TypeError("MidiStore requires a database");
    if (!root) throw new TypeError("MidiStore requires a managed root");
    this.db = db;
    this.root = resolve(root);
    this.now = now;
    this.randomId = randomId;
    this.#initSchema();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS midi_upload_tokens (
        token TEXT PRIMARY KEY,
        upload_key TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        input_path TEXT,
        sha256 TEXT,
        size_bytes INTEGER,
        max_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS midi_jobs (
        id TEXT PRIMARY KEY,
        upload_key TEXT NOT NULL REFERENCES midi_upload_tokens(upload_key),
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        input_path TEXT NOT NULL,
        timeline_path TEXT,
        audio_path TEXT,
        video_path TEXT,
        duration_us INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS midi_jobs_state_created ON midi_jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS user_songs (
        id TEXT PRIMARY KEY,
        job_id TEXT UNIQUE REFERENCES midi_jobs(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        midi_path TEXT,
        video_path TEXT,
        duration_us INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT UNIQUE,
        performance_type TEXT NOT NULL DEFAULT 'Solo',
        video_by_tod_view TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_library_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS song_name_corrections (
        fingerprint TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        corrected_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS song_name_corrections_identity ON song_name_corrections(identity);
      INSERT INTO media_library_meta(id, revision) VALUES(1, 0)
      ON CONFLICT(id) DO NOTHING;
      CREATE INDEX IF NOT EXISTS user_songs_created ON user_songs(created_at DESC);
      CREATE INDEX IF NOT EXISTS user_songs_name_key ON user_songs(name_key);
    `);
    const songColumns = new Set(this.db.prepare("PRAGMA table_info(user_songs)").all().map(column => column.name));
    if (!songColumns.has("performance_type"))
      this.db.exec("ALTER TABLE user_songs ADD COLUMN performance_type TEXT NOT NULL DEFAULT 'Solo'");
    for (const column of ["custom_name", "custom_name_key", "corrected_name", "corrected_name_key", "time_of_day_mapping"]) {
      if (!songColumns.has(column)) this.db.exec(`ALTER TABLE user_songs ADD COLUMN ${column} TEXT`);
    }
  }

  #bumpLibraryRevision() {
    this.db.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
  }

  libraryRevision() {
    return Math.max(0, Number(this.db.prepare("SELECT revision FROM media_library_meta WHERE id = 1").get()?.revision) || 0);
  }

  #transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  encodePath(value, options = {}) {
    if (value == null || value === "") return null;
    const candidate = String(value);
    if (!isAbsolute(candidate)) {
      const normalized = slash(candidate).replace(/^\.\//u, "");
      if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
        fail("MIDI_PATH_OUTSIDE_ROOT", "Relative MIDI path escapes the managed root");
      }
      return normalized;
    }

    const absolute = resolve(candidate);
    if (options.externalRoot) {
      if (!within(options.externalRoot, absolute)) {
        fail("MIDI_PATH_OUTSIDE_LIBRARY", "External song path is outside the selected library root");
      }
      return `external:${absolute}`;
    }
    if (!within(this.root, absolute)) {
      fail("MIDI_PATH_OUTSIDE_ROOT", "MIDI path is outside the managed root");
    }
    return slash(relative(this.root, absolute));
  }

  resolvePath(storedPath) {
    if (!storedPath) return null;
    if (storedPath.startsWith("external:")) return storedPath.slice("external:".length);
    return resolve(this.root, storedPath);
  }

  createUploadToken({ originalFilename, lifetimeSeconds = 5 * 60, maxBytes = 64 * 1024 * 1024 }) {
    const token = this.randomId();
    const filename = safeFilename(originalFilename);
    const key = `uploads/${token}/${filename}`;
    const expiresAt = this.now() + lifetimeSeconds;
    this.db.prepare(`
      INSERT INTO midi_upload_tokens(token, upload_key, original_filename, expires_at, max_bytes)
      VALUES(?, ?, ?, ?, ?)
    `).run(token, key, String(originalFilename ?? filename), expiresAt, maxBytes);
    return { token, key, filename, expiresAt, maxBytes };
  }

  consumeUploadToken(token, { inputPath, sha256, sizeBytes }) {
    return this.#transaction(() => {
      const row = this.db.prepare("SELECT * FROM midi_upload_tokens WHERE token = ?").get(token);
      if (!row) fail("UPLOAD_TOKEN_INVALID", "Upload token does not exist");
      if (row.consumed_at != null) fail("UPLOAD_TOKEN_USED", "Upload token has already been used");
      if (row.expires_at < this.now()) fail("UPLOAD_TOKEN_EXPIRED", "Upload token has expired");
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > row.max_bytes) {
        fail("MIDI_TOO_LARGE", "Uploaded MIDI exceeds its allowed size");
      }
      if (!/^[a-f0-9]{64}$/u.test(sha256)) fail("MIDI_HASH_INVALID", "MIDI SHA-256 is invalid");
      const storedPath = this.encodePath(inputPath);
      this.db.prepare(`
        UPDATE midi_upload_tokens
        SET consumed_at = ?, input_path = ?, sha256 = ?, size_bytes = ?
        WHERE token = ? AND consumed_at IS NULL
      `).run(this.now(), storedPath, sha256, sizeBytes, token);
      return uploadFromRow(this.db.prepare("SELECT * FROM midi_upload_tokens WHERE token = ?").get(token));
    });
  }

  getUploadByKey(key) {
    return uploadFromRow(this.db.prepare("SELECT * FROM midi_upload_tokens WHERE upload_key = ?").get(key));
  }

  getUploadByToken(token) {
    return uploadFromRow(this.db.prepare("SELECT * FROM midi_upload_tokens WHERE token = ?").get(token));
  }

  getRecentUnclaimedUpload({ maxAgeSeconds = 10 * 60 } = {}) {
    const minimumConsumedAt = this.now() - maxAgeSeconds;
    return uploadFromRow(this.db.prepare(`
      SELECT upload.*
      FROM midi_upload_tokens AS upload
      LEFT JOIN midi_jobs AS job ON job.upload_key = upload.upload_key
      WHERE upload.consumed_at IS NOT NULL
        AND upload.input_path IS NOT NULL
        AND upload.consumed_at >= ?
        AND job.id IS NULL
      ORDER BY upload.consumed_at DESC, upload.rowid DESC
      LIMIT 1
    `).get(minimumConsumedAt));
  }

  createJob({ uploadKey, title }) {
    const upload = this.getUploadByKey(uploadKey);
    if (!upload?.consumedAt || !upload.inputPath) fail("MIDI_UPLOAD_NOT_READY", "MIDI upload is not complete");
    const id = this.randomId();
    const now = this.now();
    this.db.prepare(`
      INSERT INTO midi_jobs(id, upload_key, title, state, input_path, created_at, updated_at)
      VALUES(?, ?, ?, 'queued', ?, ?, ?)
    `).run(id, uploadKey, String(title ?? "").trim() || basename(upload.originalFilename), upload.inputPath, now, now);
    return this.getJob(id);
  }

  getJob(id) {
    return jobFromRow(this.db.prepare("SELECT * FROM midi_jobs WHERE id = ?").get(id));
  }

  listJobs() {
    return this.db.prepare("SELECT * FROM midi_jobs ORDER BY created_at DESC, rowid DESC").all().map(jobFromRow);
  }

  transitionJob(id, nextState, details = {}) {
    const current = this.getJob(id);
    if (!current) fail("MIDI_JOB_NOT_FOUND", "MIDI job does not exist");
    if (!TRANSITIONS.get(current.state)?.has(nextState)) {
      fail("MIDI_JOB_TRANSITION_INVALID", `Cannot transition MIDI job from ${current.state} to ${nextState}`);
    }
    const progress = details.progress == null
      ? current.progress
      : Math.max(0, Math.min(100, Math.trunc(details.progress)));
    const values = {
      error: details.error == null ? current.error : String(details.error).slice(0, 2000),
      timelinePath: details.timelinePath == null ? current.timelinePath : this.encodePath(details.timelinePath),
      audioPath: details.audioPath == null ? current.audioPath : this.encodePath(details.audioPath),
      videoPath: details.videoPath == null ? current.videoPath : this.encodePath(details.videoPath),
      durationUs: details.durationUs == null ? current.durationUs : details.durationUs,
    };
    this.db.prepare(`
      UPDATE midi_jobs SET
        state = ?, progress = ?, error = ?, timeline_path = ?, audio_path = ?, video_path = ?,
        duration_us = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextState,
      progress,
      values.error,
      values.timelinePath,
      values.audioPath,
      values.videoPath,
      values.durationUs,
      this.now(),
      id,
    );
    return this.getJob(id);
  }

  requestCancellation(id) {
    const job = this.getJob(id);
    if (!job) fail("MIDI_JOB_NOT_FOUND", "MIDI job does not exist");
    if (TERMINAL_STATES.has(job.state)) return job;
    this.db.prepare("UPDATE midi_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
      .run(this.now(), id);
    return this.getJob(id);
  }

  requeueInterruptedJobs() {
    const placeholders = RUNNING_STATES.map(() => "?").join(", ");
    const result = this.db.prepare(`
      UPDATE midi_jobs
      SET state = 'queued', progress = 0, error = '服务重启后重新排队', cancel_requested = 0, updated_at = ?
      WHERE state IN (${placeholders})
    `).run(this.now(), ...RUNNING_STATES);
    return Number(result.changes);
  }

  deleteJob(id) {
    const job = this.getJob(id);
    if (!job) return false;
    if (!TERMINAL_STATES.has(job.state)) fail("MIDI_JOB_ACTIVE", "Active MIDI job cannot be deleted");
    return Number(this.db.prepare("DELETE FROM midi_jobs WHERE id = ?").run(id).changes) > 0;
  }

  upsertUserSong({
    id,
    jobId = null,
    name,
    sourceKind,
    midiPath = null,
    videoPath = null,
    durationUs = 0,
    contentHash = null,
    performanceType = "Solo",
    videoByTodView = {},
    externalRoot,
  }) {
    if (contentHash) {
      const existing = this.db.prepare("SELECT * FROM user_songs WHERE content_hash = ?").get(contentHash);
      if (existing) return songFromRow(existing);
    }
    const songId = id ?? this.randomId();
    const displayName = String(name ?? "").trim();
    if (!displayName) fail("MIDI_SONG_NAME_REQUIRED", "Song name is required");
    const now = this.now();
    const variants = Object.fromEntries(Object.entries(videoByTodView).map(([key, value]) => [
      key,
      isAbsolute(value) ? this.encodePath(value, { externalRoot }) : slash(value),
    ]));
    this.db.prepare(`
      INSERT INTO user_songs(
        id, job_id, name, name_key, source_kind, midi_path, video_path, duration_us,
        content_hash, performance_type, video_by_tod_view, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        job_id = excluded.job_id,
        source_kind = excluded.source_kind,
        midi_path = excluded.midi_path,
        video_path = excluded.video_path,
        duration_us = excluded.duration_us,
        content_hash = excluded.content_hash,
        performance_type = excluded.performance_type,
        video_by_tod_view = excluded.video_by_tod_view,
        updated_at = excluded.updated_at
    `).run(
      songId,
      jobId,
      displayName,
      displayName.normalize("NFKC").toLocaleLowerCase(),
      String(sourceKind ?? "upload"),
      midiPath ? this.encodePath(midiPath, { externalRoot }) : null,
      videoPath ? this.encodePath(videoPath, { externalRoot }) : null,
      Math.max(0, Math.trunc(durationUs)),
      contentHash,
      normalizePerformanceType(performanceType),
      JSON.stringify(variants),
      now,
      now,
    );
    const correction = contentHash && this.db.prepare("SELECT * FROM song_name_corrections WHERE fingerprint = ?").get(contentHash);
    if (correction) this.db.prepare("UPDATE user_songs SET corrected_name = ?, corrected_name_key = ? WHERE id = ?")
      .run(correction.corrected_name, correction.corrected_name.normalize("NFKC").toLocaleLowerCase(), songId);
    this.#bumpLibraryRevision();
    return this.getUserSong(songId);
  }

  getUserSong(id) {
    return songFromRow(this.db.prepare("SELECT * FROM user_songs WHERE id = ?").get(id));
  }

  updateUserSongMetadata(id, patch, correctionFingerprints = []) {
    return this.#transaction(() => {
      const song = this.getUserSong(id);
      if (!song) fail("MIDI_SONG_NOT_FOUND", "Song does not exist");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("MIDI_SONG_NAME_INVALID", "Metadata must be an object");
      let name = song.customName;
      let correctedName = song.correctedName;
      let mapping = song.timeOfDayMapping;
      if (Object.hasOwn(patch, "name")) {
        if (patch.name !== null && (typeof patch.name !== "string" || !patch.name.trim() || [...patch.name.trim()].length > 200 || /\p{Cc}/u.test(patch.name))) fail("MIDI_SONG_NAME_INVALID", "Name must be 1-200 characters without controls");
        name = patch.name === null ? null : patch.name.trim();
      }
      if (Object.hasOwn(patch, "permanentName")) {
        const value = patch.permanentName;
        if (Object.hasOwn(patch, "name") || typeof value !== "string" || !value.trim() || [...value.trim()].length > 200 || /\p{Cc}/u.test(value)) fail("MIDI_SONG_NAME_INVALID", "Permanent name must be 1-200 characters without controls and cannot include a display override");
        correctedName = value.trim();
        name = null;
      }
      if (Object.hasOwn(patch, "timeOfDayMapping")) {
        const value = patch.timeOfDayMapping;
        if (value === null) mapping = null;
        else {
          const keys = new Set(songVariants(song).map(item => item.key));
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([slot, key]) => !TIME_SLOTS.includes(slot) || (key !== null && !keys.has(key)))) fail("MIDI_SONG_MAPPING_INVALID", "Time slots must reference existing variants");
          mapping = Object.fromEntries(TIME_SLOTS.map(slot => [slot, value[slot] ?? null]));
        }
      }
      if (Object.hasOwn(patch, "permanentName")) {
        const existing = this.db.prepare("SELECT identity FROM song_name_corrections WHERE fingerprint = ?").get(song.contentHash);
        const identity = existing?.identity ?? song.contentHash;
        const fingerprints = [...new Set([song.contentHash, ...this.getSongNameCorrectionFingerprints(song.contentHash), ...correctionFingerprints].filter(value => /^[a-f0-9]{64}$/u.test(value ?? "")))];
        const updatedAt = Math.max(Date.now(), Number(this.db.prepare("SELECT MAX(updated_at) value FROM song_name_corrections").get().value ?? 0) + 1);
        for (const fingerprint of fingerprints) this.db.prepare("INSERT INTO song_name_corrections(fingerprint, identity, corrected_name, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET identity = excluded.identity, corrected_name = excluded.corrected_name, updated_at = excluded.updated_at")
          .run(fingerprint, identity, correctedName, updatedAt);
      }
      if (!Object.hasOwn(patch, "permanentName") && name === song.customName && JSON.stringify(mapping) === JSON.stringify(song.timeOfDayMapping)) return song;
      this.db.prepare("UPDATE user_songs SET custom_name = ?, custom_name_key = ?, corrected_name = ?, corrected_name_key = ?, time_of_day_mapping = ?, updated_at = ? WHERE id = ?")
        .run(name, name?.normalize("NFKC").toLocaleLowerCase() ?? null, correctedName, correctedName?.normalize("NFKC").toLocaleLowerCase() ?? null, mapping === null ? null : JSON.stringify(mapping), this.now(), id);
      this.#bumpLibraryRevision();
      return this.getUserSong(id);
    });
  }

  listSongNameCorrections() {
    return this.db.prepare("SELECT fingerprint, identity, corrected_name AS correctedName, updated_at AS updatedAt FROM song_name_corrections ORDER BY fingerprint").all().map(row => ({ ...row }));
  }

  listUserSongsWithCorrections() {
    return this.db.prepare("SELECT * FROM user_songs WHERE corrected_name IS NOT NULL").all().map(songFromRow);
  }

  getSongNameCorrectionFingerprints(fingerprint) {
    return this.db.prepare("SELECT fingerprint FROM song_name_corrections WHERE identity = (SELECT identity FROM song_name_corrections WHERE fingerprint = ?)").all(fingerprint).map(row => row.fingerprint);
  }

  restoreSongNameCorrections(records) {
    return this.#transaction(() => {
      const winners = new Map();
      const consider = record => {
        if (!winners.has(record.identity) || record.updatedAt > winners.get(record.identity).updatedAt) winners.set(record.identity, record);
      };
      // Existing database records are considered first so equal timestamps
      // cannot let an older projection override the authoritative DB value.
      this.listSongNameCorrections().forEach(consider);
      for (const record of records) this.db.prepare(`INSERT INTO song_name_corrections(fingerprint, identity, corrected_name, updated_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET identity = excluded.identity, corrected_name = excluded.corrected_name, updated_at = excluded.updated_at
        WHERE excluded.updated_at > song_name_corrections.updated_at`).run(record.fingerprint, record.identity, record.correctedName, record.updatedAt);
      this.listSongNameCorrections().forEach(consider);
      for (const record of winners.values()) this.db.prepare("UPDATE song_name_corrections SET corrected_name = ?, updated_at = ? WHERE identity = ?")
        .run(record.correctedName, record.updatedAt, record.identity);
      let changes = 0;
      for (const record of this.listSongNameCorrections()) changes += Number(this.db.prepare(`UPDATE user_songs SET corrected_name = ?, corrected_name_key = ?
        WHERE content_hash = ? AND (corrected_name IS NULL OR corrected_name <> ?)`).run(record.correctedName, record.correctedName.normalize("NFKC").toLocaleLowerCase(), record.fingerprint, record.correctedName).changes);
      if (changes) this.#bumpLibraryRevision();
    });
  }

  listUserSongs(query = "") {
    const nameKey = String(query ?? "").trim().normalize("NFKC").toLocaleLowerCase();
    const rows = nameKey
      ? this.db.prepare(`
          SELECT * FROM user_songs
          WHERE instr(COALESCE(custom_name_key, corrected_name_key, name_key), ?) > 0
          ORDER BY created_at DESC, rowid DESC
        `).all(nameKey)
      : this.db.prepare("SELECT * FROM user_songs ORDER BY created_at DESC, rowid DESC").all();
    return rows.map(songFromRow);
  }

  listPublishedUserSongs(query = "") {
    return this.listUserSongs(query).filter(song => song.sourceKind !== "upload" && !song.jobId);
  }

  pagePublishedUserSongs({ query = "", pageSize = 100, cursor = null } = {}) {
    const limit = Math.min(100, Math.max(1, Number(pageSize) || 100));
    const nameKey = String(query ?? "").trim().normalize("NFKC").toLocaleLowerCase();
    const position = decodeCursor(cursor);
    const filters = ["source_kind <> 'upload'", "job_id IS NULL"];
    const parameters = [];
    if (nameKey) {
      filters.push("instr(COALESCE(custom_name_key, corrected_name_key, name_key), ?) > 0");
      parameters.push(nameKey);
    }
    if (position) {
      filters.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      parameters.push(position.createdAt, position.createdAt, position.rowid);
    }
    const rows = this.db.prepare(`
      SELECT rowid AS _rowid, * FROM user_songs
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(...parameters, limit + 1);
    const countFilters = ["source_kind <> 'upload'", "job_id IS NULL"];
    const countParameters = [];
    if (nameKey) {
      countFilters.push("instr(COALESCE(custom_name_key, corrected_name_key, name_key), ?) > 0");
      countParameters.push(nameKey);
    }
    const total = Number(this.db.prepare(`
      SELECT COUNT(*) count FROM user_songs WHERE ${countFilters.join(" AND ")}
    `).get(...countParameters).count);
    const pageRows = rows.slice(0, limit);
    return {
      list: pageRows.map(songFromRow),
      total,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? encodeCursor(pageRows.at(-1)) : null,
      revision: this.libraryRevision(),
    };
  }

  listUserSongsMissingDuration() {
    return this.db.prepare(`
      SELECT * FROM user_songs
      WHERE video_path IS NOT NULL AND video_path <> '' AND duration_us <= 0
      ORDER BY created_at ASC, rowid ASC
    `).all().map(songFromRow);
  }

  updateUserSongDuration(id, durationUs) {
    const value = Math.trunc(Number(durationUs));
    if (!Number.isSafeInteger(value) || value <= 0)
      fail("MIDI_DURATION_INVALID", "Song duration must be a positive integer in microseconds");
    const result = this.db.prepare(`
      UPDATE user_songs SET duration_us = ?, updated_at = ? WHERE id = ?
    `).run(value, this.now(), id);
    if (!result.changes) fail("MIDI_SONG_NOT_FOUND", "Song does not exist");
    this.#bumpLibraryRevision();
    return this.getUserSong(id);
  }

  deleteUserSong(id) {
    const deleted = Number(this.db.prepare("DELETE FROM user_songs WHERE id = ?").run(id).changes) > 0;
    if (deleted) this.#bumpLibraryRevision();
    return deleted;
  }
}
