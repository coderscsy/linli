import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { songVariants } from "./song-metadata.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const safeErrors = new Set([
  "名称纠错记录格式无效，未覆盖原文件", "原始视频不可用，无法保存跨导入名称标识",
  "原始视频已变化，请重试名称保存", "作品缺少可验证的内容标识，纠错暂仅保存在数据库",
  "旧导入作品的内容标识待同步，请在该作品编辑器重试永久名称保存", "缺少原始视频解析器",
]);
function validateDocument(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.records)) throw new Error("名称纠错记录格式无效，未覆盖原文件");
  const seen = new Set();
  for (const row of document.records) {
    if (!row || !hashPattern.test(row.fingerprint ?? "") || !hashPattern.test(row.identity ?? "")
      || typeof row.correctedName !== "string" || !row.correctedName.trim() || [...row.correctedName].length > 200 || /\p{Cc}/u.test(row.correctedName)
      || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 || seen.has(row.fingerprint)) throw new Error("名称纠错记录格式无效，未覆盖原文件");
    seen.add(row.fingerprint);
  }
  return document.records;
}
async function readRecords(path) {
  try { return validateDocument(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function project(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(`${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
function signature(info) { return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`; }
async function fingerprintFile(path, signal) {
  const before = await stat(path);
  if (!before.isFile() || !before.size) throw new Error("原始视频不可用，无法保存跨导入名称标识");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  if (signature(before) !== signature(await stat(path))) throw new Error("原始视频已变化，请重试名称保存");
  return hash.digest("hex");
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Only short DB writes and flushed JSON snapshots share the foreground queue.
// Legacy source hashing is a deduplicated, abortable background worker: a title
// is durable before acknowledgement and a second rename never waits for media.
export async function createSongNameCorrections({ root, store, resolveSongPreview }) {
  const path = join(root, "settings", "song-name-corrections.json");
  let sync = { state: "synced", error: null };
  const identities = new Map();
  const pending = new Map();
  const cancellation = new AbortController();
  let closed = false;
  let running = null;
  let worker = null;
  let queue = Promise.resolve();
  const failureStatus = error => {
    const detail = /^[A-Z][A-Z0-9_]{0,80}$/u.test(error?.code ?? "") ? error.code
      : safeErrors.has(error?.message) ? error.message : "请检查纠错记录文件及原始媒体后重试";
    return { state: "failed", error: `名称纠错记录同步失败（数据库中的名称仍有效）：${detail}` };
  };
  const failed = error => { sync = failureStatus(error); };
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function snapshot(song) {
    return JSON.stringify([song.contentHash, song.sourceKind, songVariants(song).map(({ key, path }) => [key, path]).sort(([a], [b]) => a.localeCompare(b, "en"))]);
  }
  function identityStatus(song) {
    if (!hashPattern.test(song.contentHash ?? "")) return failureStatus(new Error("作品缺少可验证的内容标识，纠错暂仅保存在数据库"));
    const variants = songVariants(song);
    const legacy = song.sourceKind === "import" && variants.length
      && variants.every(item => store.resolvePath(item.path).replaceAll("\\", "/").endsWith(`/.faststart-cache/${song.contentHash}/${item.key}.mp4`));
    return legacy && store.getSongNameCorrectionFingerprints(song.contentHash).length < 2
      ? { state: "pending", error: null } : { state: "synced", error: null };
  }
  async function synchronize() {
    store.restoreSongNameCorrections(await readRecords(path));
    const records = store.listSongNameCorrections();
    if (records.length) await project(path, records);
    sync = { state: "synced", error: null };
  }
  function schedule(song) {
    if (closed || sync.state === "failed" || identities.get(song.id)?.state !== "pending") return;
    const version = snapshot(song);
    if (running?.song.id === song.id && running.version === version) return;
    pending.set(song.id, { song, version });
    if (worker) return;
    // Yield so the flushed name response is not delayed by scans or hash setup.
    worker = new Promise(resolve => setImmediate(resolve)).then(async () => {
      while (!closed && pending.size) {
        const [id, job] = pending.entries().next().value;
        pending.delete(id);
        running = job;
        try {
          if (!resolveSongPreview) throw new Error("缺少原始视频解析器");
          const hash = createHash("sha256");
          const signal = cancellation.signal;
          for (const variant of songVariants(job.song).sort((a, b) => a.key.localeCompare(b.key, "en"))) {
            signal.throwIfAborted();
            let fingerprint;
            if (resolveSongPreview.sourceFingerprint) {
              ({ sha256: fingerprint } = await abortable(resolveSongPreview.sourceFingerprint(job.song, variant.key, { signal }), signal));
            } else {
              const source = await abortable(resolveSongPreview(job.song, variant.key, { originalSource: true, signal }), signal);
              signal.throwIfAborted();
              fingerprint = await fingerprintFile(source, signal);
            }
            if (!hashPattern.test(fingerprint ?? "")) throw new Error("原始视频不可用，无法保存跨导入名称标识");
            hash.update(`${variant.key}\0${fingerprint}\0`, "utf8");
          }
          if (closed) break;
          const fingerprint = hash.digest("hex");
          await enqueue(async () => {
            if (closed) return;
            const portable = await readRecords(path);
            if (closed) return;
            const current = store.getUserSong(id);
            if (!current) { identities.delete(id); return; }
            if (snapshot(current) !== job.version) {
              identities.set(id, failureStatus(new Error("原始视频已变化，请重试名称保存")));
              return;
            }
            // Reload the latest correction, not the title captured before a
            // potentially long scan; never undo edits made while hashing.
            store.restoreSongNameCorrections(portable);
            const record = store.listSongNameCorrections().find(item => item.fingerprint === current.contentHash);
            if (!record) return;
            store.restoreSongNameCorrections([{ ...record, fingerprint }]);
            await project(path, store.listSongNameCorrections());
            identities.set(id, { state: "synced", error: null });
          });
        } catch (error) {
          if (!closed) identities.set(id, failureStatus(error));
        } finally { running = null; }
      }
    }).finally(() => { worker = null; });
  }
  try { await synchronize(); } catch (error) { failed(error); }
  // Startup restores only the small durable document. Media work starts after
  // the HTTP listener is available; unfinished jobs are inferred from DB aliases.
  for (const song of store.listUserSongsWithCorrections()) identities.set(song.id, identityStatus(song));
  return {
    status: id => ({ ...(sync.state === "failed" ? sync : (id == null
      ? [...identities.values()].find(item => item.state === "failed") ?? [...identities.values()].find(item => item.state === "pending")
      : identities.get(id)) ?? sync) }),
    start() {
      if (closed) return;
      for (const song of store.listUserSongsWithCorrections()) schedule(song);
    },
    save(id, patch) {
      if (closed) return Promise.reject(new Error("Name corrections manager is closed"));
      return enqueue(async () => {
        if (closed) throw new Error("Name corrections manager is closed");
        if (!Object.hasOwn(patch, "permanentName")) return store.updateUserSongMetadata(id, patch);
        store.updateUserSongMetadata(id, patch);
        try { await synchronize(); } catch (error) { failed(error); }
        const song = store.getUserSong(id);
        if (!song) {
          identities.delete(id);
          throw Object.assign(new Error("作品已移除"), { code: "MIDI_SONG_NOT_FOUND", status: 404 });
        }
        identities.set(id, identityStatus(song));
        schedule(song);
        return song;
      });
    },
    async whenIdle() { while (worker) await worker; await queue; },
    async close() {
      closed = true;
      pending.clear();
      cancellation.abort();
      if (worker) await worker;
      await queue;
    },
  };
}
