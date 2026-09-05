import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function quickCheck(db, label) {
  const result = db.prepare("PRAGMA quick_check").get()?.quick_check;
  if (result !== "ok") throw new Error(`${label}数据库完整性检查失败：${result ?? "无结果"}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function letterIdentity(row) {
  return createHash("sha256").update(JSON.stringify([
    text(row.content).trim(),
    text(row.letter_date).trim(),
    text(row.letter_time, "12:00").trim(),
  ]), "utf8").digest("hex");
}

function stableConflictId(sourcePath, row) {
  return `legacy-${createHash("sha256").update(`${resolve(sourcePath)}\u0000${row.id}\u0000${letterIdentity(row)}`)
    .digest("hex").slice(0, 32)}`;
}

function markdownFiles(root, result = []) {
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) markdownFiles(path, result);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(path);
  }
  return result;
}

function parseLegacyArchive(path) {
  const content = readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
  const person = /^# 往来 · (.+)$/mu.exec(content)?.[1]?.trim() || basename(path, ".md");
  const sections = [...content.matchAll(/^### 往来 (\d+)(?: · ((?:[01]\d|2[0-3]):[0-5]\d))?\s*$/gmu)];
  const exchanges = [];
  sections.forEach((section, index) => {
    const block = content.slice(section.index + section[0].length, sections[index + 1]?.index ?? content.length);
    const pair = /#### 我（信件）\s*\n+([\s\S]*?)\n+#### 林离（(回信|视频回复|等待回信)）\s*\n+([\s\S]*?)(?=\n---\s*(?:\n|$)|$)/u.exec(block);
    if (!pair || !pair[1].trim()) return;
    const dates = [...content.slice(0, section.index).matchAll(/^## (\d{4}-\d{2}-\d{2}|未注明日期)\s*$/gmu)];
    const dateHeading = dates.at(-1)?.[1];
    if (!dateHeading) return;
    const incoming = pair[1].trim();
    const rawReply = pair[3].trim();
    const waiting = pair[2] === "等待回信" || rawReply === "（等待回信）";
    exchanges.push({
      date: dateHeading === "未注明日期" ? "" : dateHeading,
      time: section[2] || "12:00",
      incoming,
      reply: waiting ? "" : rawReply,
      replyLabel: pair[2] === "视频回复" ? "视频回复" : "回信",
      isRead: /状态：[^\n]*已读/u.test(block) ? 1 : 0,
    });
  });
  return { person, content, exchanges };
}

function exchangeContentMd5(exchange) {
  return createHash("md5").update(`${exchange.incoming.trim()}\n---\n${exchange.reply.trim()}`, "utf8").digest("hex");
}

function availableStoredVideo(value) {
  const stored = text(value).trim();
  if (!stored) return null;
  const path = stored.startsWith("external:") ? stored.slice("external:".length) : stored;
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path) || !existsSync(path)) return null;
  return { stored: `external:${resolve(path)}`, path: resolve(path) };
}

function availableSongVideos(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(text(row.video_by_tod_view, "{}"));
  } catch {
    parsed = {};
  }
  const variants = {};
  for (const [key, value] of Object.entries(parsed)) {
    const available = availableStoredVideo(value);
    if (available) variants[key] = available.stored;
  }
  const primary = availableStoredVideo(row.video_path) ?? availableStoredVideo(Object.values(variants)[0]);
  if (!primary) return null;
  if (!Object.keys(variants).length) variants.DEFAULT = primary.stored;
  return { primary: primary.stored, variants };
}

function mergeLegacySettings(targetDb, sourceDb) {
  if (!tableExists(sourceDb, "settings") || !tableExists(targetDb, "settings")) return 0;
  const rules = new Map([
    ["daily_letter_limit", { defaultValue: "3", isDefault: value => Number(value) === 3, valid: value => /^\d{1,3}$/u.test(value) && Number(value) <= 999 }],
    ["offline_uid", { defaultValue: "5200", valid: value => /^\d{1,18}$/u.test(value) }],
    ["offline_nickname", { defaultValue: "用户", valid: value => Boolean(value) && value.length <= 32 && !/[\x00-\x1F\x7F]/u.test(value) }],
    ["reply_delay_seconds_v2", { defaultValue: "300", isDefault: value => Number(value) === 300, valid: value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 86400 }],
    ["midi_library_root", { defaultValue: "", valid: value => /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value) }],
  ]);
  let imported = 0;
  for (const [key, rule] of rules) {
    const sourceValue = text(sourceDb.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value).trim();
    if (!rule.valid(sourceValue)) continue;
    const current = targetDb.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
    if (current !== undefined && !(rule.isDefault ? rule.isDefault(current) : String(current) === rule.defaultValue)) continue;
    targetDb.prepare(`
      INSERT INTO settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, sourceValue);
    if (key === "offline_nickname" && sourceValue !== "用户") {
      const defaultUser = targetDb.prepare(
        "SELECT id FROM users WHERE username = '用户' AND person = '用户' ORDER BY id LIMIT 1",
      ).get();
      const nicknameTaken = targetDb.prepare(
        "SELECT 1 FROM users WHERE username = ? OR person = ? LIMIT 1",
      ).get(sourceValue, sourceValue);
      if (defaultUser && !nicknameTaken) {
        targetDb.prepare("UPDATE users SET username = ?, person = ? WHERE id = ?")
          .run(sourceValue, sourceValue, defaultUser.id);
        targetDb.prepare("UPDATE letters SET person = ? WHERE user_id = ?")
          .run(sourceValue, defaultUser.id);
      }
    }
    imported += 1;
  }
  if (imported && targetDb.prepare("SELECT value FROM settings WHERE key = 'midi_library_root'").get()?.value)
    targetDb.prepare(`
      INSERT INTO settings(key, value) VALUES('midi_library_mode', 'copy')
      ON CONFLICT(key) DO UPDATE SET value = 'copy'
    `).run();
  return imported;
}

function alignDefaultUserWithSavedNickname(targetDb) {
  const nickname = text(targetDb.prepare(
    "SELECT value FROM settings WHERE key = 'offline_nickname'",
  ).get()?.value, "用户").trim();
  if (!nickname || nickname === "用户") return;
  const defaultUser = targetDb.prepare(
    "SELECT id FROM users WHERE username = '用户' AND person = '用户' ORDER BY id LIMIT 1",
  ).get();
  const nicknameTaken = targetDb.prepare(
    "SELECT 1 FROM users WHERE (username = ? OR person = ?) AND id != ? LIMIT 1",
  ).get(nickname, nickname, defaultUser?.id ?? -1);
  if (!defaultUser || nicknameTaken) return;
  targetDb.prepare("UPDATE users SET username = ?, person = ? WHERE id = ?")
    .run(nickname, nickname, defaultUser.id);
  targetDb.prepare("UPDATE letters SET person = ? WHERE user_id = ?")
    .run(nickname, defaultUser.id);
}

export async function restoreLegacyModelConfig({ targetRoot, sourceRoots = [], allowImport = false }) {
  if (allowImport !== true) return { restored: [] };
  const targetSecrets = join(resolve(targetRoot), ".cursor", "secrets");
  const restored = [];
  for (const name of ["model.env", "deepseek.env"]) {
    const target = join(targetSecrets, name);
    try {
      await access(target);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const root of [...new Set(sourceRoots.map(path => resolve(path)))]) {
      const source = join(root, ".cursor", "secrets", name);
      try {
        await access(source);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      await mkdir(targetSecrets, { recursive: true });
      await copyFile(source, target);
      restored.push(name);
      break;
    }
  }
  return { restored };
}

function mapUser(targetDb, sourceUser) {
  const username = text(sourceUser.username, text(sourceUser.person, "用户")) || "用户";
  const person = text(sourceUser.person, username) || username;
  const existing = targetDb.prepare("SELECT * FROM users WHERE username = ? OR person = ? ORDER BY id LIMIT 1")
    .get(username, person);
  if (existing) return existing.id;
  const createdAt = number(sourceUser.created_at, Math.floor(Date.now() / 1000));
  return Number(targetDb.prepare(`
    INSERT INTO users(username, person, created_at, last_login_at) VALUES(?, ?, ?, ?)
  `).run(username, person, createdAt, number(sourceUser.last_login_at, createdAt)).lastInsertRowid);
}

function mergeMoreComplete(targetDb, target, source) {
  const sourceReply = text(source.reply_text);
  const targetReply = text(target.reply_text);
  const replyText = sourceReply.length > targetReply.length ? sourceReply : targetReply;
  const replyVideo = text(target.reply_video) || text(source.reply_video) || null;
  const sourceReplied = number(source.status) === 4 && Boolean(sourceReply);
  const status = sourceReplied && number(target.status) !== 4 ? 4 : number(target.status, number(source.status, 1));
  targetDb.prepare(`
    UPDATE letters SET
      reply_text = ?, reply_video = ?, reply_type = ?, status = ?,
      replied_at = COALESCE(replied_at, ?), is_read = MAX(is_read, ?),
      letter_date = CASE WHEN letter_date = '' THEN ? ELSE letter_date END,
      letter_time = CASE WHEN letter_time = '' THEN ? ELSE letter_time END,
      reply_label = CASE WHEN reply_label = '' THEN ? ELSE reply_label END,
      content_md5 = COALESCE(content_md5, ?)
    WHERE id = ?
  `).run(
    replyText || null,
    replyVideo,
    replyVideo ? 2 : replyText ? 1 : number(target.reply_type),
    status,
    source.replied_at ?? null,
    number(source.is_read),
    text(source.letter_date),
    text(source.letter_time, "12:00"),
    text(source.reply_label, "回信"),
    source.content_md5 ?? null,
    target.id,
  );
}

function insertLetter(targetDb, sourcePath, targetUserId, source, nextMemoryOrder) {
  let id = text(source.id);
  if (!id || targetDb.prepare("SELECT 1 FROM letters WHERE id = ?").get(id)) id = stableConflictId(sourcePath, source);
  let memoryOrder = Number.isInteger(source.memory_order) ? source.memory_order : null;
  if (memoryOrder !== null && targetDb.prepare(
    "SELECT 1 FROM letters WHERE user_id = ? AND memory_order = ?",
  ).get(targetUserId, memoryOrder)) memoryOrder = nextMemoryOrder();
  const targetPerson = text(targetDb.prepare("SELECT person FROM users WHERE id = ?").get(targetUserId)?.person, text(source.person, "用户"));
  targetDb.prepare(`
    INSERT INTO letters(
      id, user_id, person, content, material_json, status, audit_status,
      reply_type, reply_text, error, memory_error, created_at, available_at,
      replied_at, is_read, archived_at, share_id, source, reply_video,
      memory_order, letter_date, letter_time, reply_label, content_md5
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    targetUserId,
    targetPerson,
    text(source.content),
    source.material_json ?? null,
    number(source.status, 1),
    number(source.audit_status, 2),
    number(source.reply_type),
    source.reply_text ?? null,
    source.error ?? null,
    source.memory_error ?? null,
    number(source.created_at, Math.floor(Date.now() / 1000)),
    number(source.available_at, number(source.created_at, Math.floor(Date.now() / 1000))),
    source.replied_at ?? null,
    number(source.is_read),
    source.archived_at ?? null,
    source.share_id ?? null,
    text(source.source, "import"),
    source.reply_video ?? null,
    memoryOrder,
    text(source.letter_date),
    text(source.letter_time, "12:00"),
    text(source.reply_label, "回信"),
    source.content_md5 ?? null,
  );
}

export async function mergeLegacyDatabases({
  targetDb,
  targetPath,
  sourcePaths = [],
  archiveDirs = [],
  backupDir,
}) {
  const sources = [...new Set(sourcePaths.map(path => resolve(path)))]
    .filter(path => path !== resolve(targetPath) && existsSync(path))
    .map(path => {
      const info = statSync(path);
      const key = `legacy_db_merged_v3:${createHash("sha256").update(path.toLowerCase()).digest("hex")}`;
      return { path, key, fingerprint: `${info.size}:${Math.floor(info.mtimeMs)}` };
    })
    .filter(source => targetDb.prepare("SELECT value FROM settings WHERE key = ?").get(source.key)?.value !== source.fingerprint);
  const archives = [...new Set(archiveDirs.map(path => resolve(path)).flatMap(path => markdownFiles(path)))]
    .map(path => {
      const parsed = parseLegacyArchive(path);
      const key = `legacy_archive_merged:${createHash("sha256").update(path.toLowerCase()).digest("hex")}`;
      const fingerprint = createHash("sha256").update(parsed.content, "utf8").digest("hex");
      return { path, key, fingerprint, ...parsed };
    })
    .filter(source => source.exchanges.length > 0)
    .filter(source => targetDb.prepare("SELECT value FROM settings WHERE key = ?").get(source.key)?.value !== source.fingerprint);
  if (!sources.length && !archives.length)
    return { sources: 0, imported: 0, merged: 0, backupPath: null };

  await mkdir(backupDir, { recursive: true });
  targetDb.exec("PRAGMA wal_checkpoint(FULL)");
  quickCheck(targetDb, "目标");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = resolve(backupDir, `before-legacy-merge-${stamp}.sqlite`);
  await backup(targetDb, backupPath);

  let imported = 0;
  let merged = 0;
  let songsImported = 0;
  let songsMerged = 0;
  let settingsImported = 0;
  targetDb.exec("BEGIN IMMEDIATE");
  try {
    for (const sourceEntry of sources) {
      const sourcePath = sourceEntry.path;
      const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        quickCheck(sourceDb, basename(sourcePath));
        if (!tableExists(sourceDb, "users") || !tableExists(sourceDb, "letters")) continue;
        settingsImported += mergeLegacySettings(targetDb, sourceDb);
        const users = new Map(sourceDb.prepare("SELECT * FROM users").all().map(user => [user.id, user]));
        const userMap = new Map();
        const nextOrders = new Map();
        for (const source of sourceDb.prepare("SELECT * FROM letters ORDER BY created_at, rowid").all()) {
          const sourceUser = users.get(source.user_id) ?? { username: source.person, person: source.person };
          if (!userMap.has(source.user_id)) userMap.set(source.user_id, mapUser(targetDb, sourceUser));
          const targetUserId = userMap.get(source.user_id);
          const sameId = text(source.id) ? targetDb.prepare("SELECT * FROM letters WHERE id = ?").get(source.id) : null;
          const identity = letterIdentity(source);
          const sameContent = targetDb.prepare(`
            SELECT * FROM letters WHERE user_id = ? AND content = ?
              AND COALESCE(letter_date, '') = ? AND COALESCE(letter_time, '12:00') = ?
            ORDER BY created_at LIMIT 1
          `).get(targetUserId, text(source.content), text(source.letter_date), text(source.letter_time, "12:00"));
          const target = sameId && letterIdentity(sameId) === identity ? sameId : sameContent;
          if (target) {
            mergeMoreComplete(targetDb, target, source);
            merged += 1;
            continue;
          }
          const nextMemoryOrder = () => {
            if (!nextOrders.has(targetUserId)) {
              const maximum = targetDb.prepare(
                "SELECT COALESCE(MAX(memory_order), 0) value FROM letters WHERE user_id = ?",
              ).get(targetUserId).value;
              nextOrders.set(targetUserId, number(maximum));
            }
            const next = nextOrders.get(targetUserId) + 1;
            nextOrders.set(targetUserId, next);
            return next;
          };
          insertLetter(targetDb, sourcePath, targetUserId, source, nextMemoryOrder);
          imported += 1;
        }
        if (tableExists(sourceDb, "user_songs") && tableExists(targetDb, "user_songs")) {
          for (const source of sourceDb.prepare("SELECT * FROM user_songs ORDER BY created_at, rowid").all()) {
            const videos = availableSongVideos(source);
            if (!videos) continue;
            const sameHash = text(source.content_hash)
              ? targetDb.prepare("SELECT * FROM user_songs WHERE content_hash = ?").get(source.content_hash)
              : null;
            const sameId = text(source.id)
              ? targetDb.prepare("SELECT * FROM user_songs WHERE id = ?").get(source.id)
              : null;
            if (sameHash || sameId) {
              songsMerged += 1;
              continue;
            }
            const id = text(source.id) || `legacy-song-${createHash("sha256")
              .update(`${sourcePath}\u0000${source.name}\u0000${videos.primary}`, "utf8").digest("hex").slice(0, 32)}`;
            const name = text(source.name, "官方作品").trim() || "官方作品";
            const contentHash = text(source.content_hash) || createHash("sha256")
              .update(JSON.stringify(videos.variants), "utf8").digest("hex");
            targetDb.prepare(`
              INSERT INTO user_songs(
                id, job_id, name, name_key, source_kind, midi_path, video_path,
                duration_us, content_hash, video_by_tod_view, created_at, updated_at
              ) VALUES(?, NULL, ?, ?, 'import', NULL, ?, ?, ?, ?, ?, ?)
            `).run(
              id,
              name,
              text(source.name_key) || name.normalize("NFKC").toLocaleLowerCase(),
              videos.primary,
              Math.max(0, Math.trunc(number(source.duration_us))),
              contentHash,
              JSON.stringify(videos.variants),
              number(source.created_at, Math.floor(Date.now() / 1000)),
              number(source.updated_at, Math.floor(Date.now() / 1000)),
            );
            songsImported += 1;
          }
        }
        targetDb.prepare(`
          INSERT INTO settings(key, value) VALUES(?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(sourceEntry.key, sourceEntry.fingerprint);
      } finally {
        sourceDb.close();
      }
    }
    for (const archive of archives) {
      const targetUserId = mapUser(targetDb, { username: archive.person, person: archive.person });
      let nextOrder = number(targetDb.prepare(
        "SELECT COALESCE(MAX(memory_order), 0) value FROM letters WHERE user_id = ?",
      ).get(targetUserId).value);
      archive.exchanges.forEach((exchange, index) => {
        const created = exchange.date
          ? Math.floor(new Date(`${exchange.date}T${exchange.time}:00`).getTime() / 1000)
          : Math.floor(statSync(archive.path).mtimeMs / 1000);
        const source = {
          id: `legacy-md-${createHash("sha256").update(`${archive.path}\u0000${index}\u0000${exchange.incoming}`, "utf8").digest("hex").slice(0, 32)}`,
          person: archive.person,
          content: exchange.incoming,
          status: exchange.reply ? 4 : 1,
          reply_type: exchange.replyLabel === "视频回复" ? 2 : exchange.reply ? 1 : 0,
          reply_text: exchange.reply || null,
          created_at: Number.isFinite(created) ? created : Math.floor(Date.now() / 1000),
          available_at: Number.isFinite(created) ? created : Math.floor(Date.now() / 1000),
          replied_at: exchange.reply && Number.isFinite(created) ? created : null,
          is_read: exchange.isRead,
          archived_at: exchange.reply ? Math.floor(Date.now() / 1000) : null,
          source: "import-markdown",
          memory_order: exchange.reply ? ++nextOrder : null,
          letter_date: exchange.date,
          letter_time: exchange.time,
          reply_label: exchange.replyLabel,
          content_md5: exchangeContentMd5(exchange),
        };
        const sameId = targetDb.prepare("SELECT * FROM letters WHERE id = ?").get(source.id);
        const sameContent = targetDb.prepare(`
          SELECT * FROM letters WHERE user_id = ? AND content = ?
            AND COALESCE(letter_date, '') = ? AND COALESCE(letter_time, '12:00') = ?
          ORDER BY created_at LIMIT 1
        `).get(targetUserId, source.content, source.letter_date, source.letter_time);
        const target = sameId ?? sameContent;
        if (target) {
          mergeMoreComplete(targetDb, target, source);
          merged += 1;
        } else {
          insertLetter(targetDb, archive.path, targetUserId, source, () => ++nextOrder);
          imported += 1;
        }
      });
      targetDb.prepare(`
        INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(archive.key, archive.fingerprint);
    }
    alignDefaultUserWithSavedNickname(targetDb);
    targetDb.exec("COMMIT");
  } catch (error) {
    targetDb.exec("ROLLBACK");
    throw error;
  }
  quickCheck(targetDb, "合并后目标");
  if (songsImported && tableExists(targetDb, "media_library_meta"))
    targetDb.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
  return {
    sources: sources.length + archives.length,
    imported,
    merged,
    songsImported,
    songsMerged,
    settingsImported,
    backupPath,
  };
}
