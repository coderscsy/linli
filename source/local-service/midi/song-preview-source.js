import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scanPerformanceLibrary } from "./library-importer.js";
import { songVariants } from "./song-metadata.js";

const MAX_INDEX_AGE_MS = 5 * 60 * 1000;

function unavailable() {
  return Object.assign(new Error("预览文件不存在或无法确认对应关系，请检查原导入目录后重试"), {
    status: 404, code: "MEDIA_PREVIEW_UNAVAILABLE", mediaResponse: true,
  });
}
function aborted() {
  return Object.assign(new Error("Preview source resolution aborted"), { name: "AbortError", code: "ABORT_ERR" });
}
function within(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function fileInfo(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 ? info : null;
  } catch { return null; }
}

async function sha256File(path, { signal } = {}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

function signature(info) {
  return info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}` : "missing";
}

function cachedFaststartPath(path, contentHash, variantKey) {
  return String(path ?? "").replaceAll("\\", "/").replaceAll(/\/{2,}/gu, "/")
    .endsWith(`/.faststart-cache/${contentHash}/${variantKey}.mp4`);
}

// Preview-only recovery: never rewrite the database, rename/copy media, or
// touch the desktop playback session. A title narrows candidates; only a
// verified content identity authorizes falling back to the import source.
export function createSongPreviewResolver({
  resolvePath,
  getLibraryRoot,
  scanLibrary = scanPerformanceLibrary,
  hashFile = sha256File,
  now = () => Date.now(),
}) {
  const hashes = new Map();
  const activeHashes = new Set();
  const activeHashTasks = new Set();
  const lifetime = new AbortController();
  let index = null;
  function ensureActive(signal) {
    if (lifetime.signal.aborted || signal?.aborted) throw aborted();
  }
  function waitFor(promise, signal) {
    // Each waiter owns its cancellation; only close() aborts shared hash I/O.
    const waiting = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted());
      Promise.resolve(promise).then(value => {
        waiting.removeEventListener("abort", onAbort);
        resolve(value);
      }, error => {
        waiting.removeEventListener("abort", onAbort);
        reject(error);
      });
      if (waiting.aborted) onAbort();
      else waiting.addEventListener("abort", onAbort, { once: true });
    });
  }
  async function fingerprint(path, info) {
    ensureActive();
    const sourceSignature = signature(info);
    const cached = hashes.get(path);
    if (cached?.signature === sourceSignature) return cached.promise;
    const controller = new AbortController();
    activeHashes.add(controller);
    const promise = (async () => {
      try {
        const value = await hashFile(path, { signal: controller.signal });
        ensureActive();
        const after = await fileInfo(path);
        ensureActive();
        if (!after || signature(after) !== sourceSignature) throw unavailable();
        return value;
      } finally { activeHashes.delete(controller); }
    })();
    activeHashTasks.add(promise);
    if (hashes.size >= 256) hashes.delete(hashes.keys().next().value);
    hashes.set(path, { signature: sourceSignature, promise });
    try { return await promise; } catch (error) {
      if (hashes.get(path)?.promise === promise) hashes.delete(path);
      throw error;
    } finally { activeHashTasks.delete(promise); }
  }
  async function librarySignature(root) {
    const [rootInfo, jsonManifest, csvManifest] = await Promise.all([
      stat(root).catch(() => null),
      fileInfo(resolve(root, "library.json")),
      fileInfo(resolve(root, "library.csv")),
    ]);
    if (!rootInfo?.isDirectory()) throw unavailable();
    return `${root}:${signature(rootInfo)}:${signature(jsonManifest)}:${signature(csvManifest)}`;
  }
  async function libraryIndex(root) {
    ensureActive();
    const currentSignature = await librarySignature(root);
    ensureActive();
    const currentTime = now();
    if (index?.signature !== currentSignature || currentTime - index.checkedAt >= MAX_INDEX_AGE_MS) {
      const promise = (async () => {
        const preview = await scanLibrary(root);
        ensureActive();
        return preview;
      })();
      index = { signature: currentSignature, checkedAt: currentTime, promise };
      const current = index;
      current.promise.catch(() => { if (index === current) index = null; });
    }
    return index.promise;
  }
  async function resolvePreview(song, variantKey, { originalSource = false, signal } = {}) {
    ensureActive(signal);
    const registered = song && songVariants(song);
    const selected = registered?.find(item => item.key === variantKey);
    if (!selected) throw unavailable();
    const direct = resolvePath(selected.path);
    if (direct && (!originalSource || !cachedFaststartPath(direct, song.contentHash, selected.key)) && await waitFor(fileInfo(direct), signal)) return direct;
    const configured = String(getLibraryRoot() ?? "").trim();
    if (!configured || !/^[a-f0-9]{64}$/u.test(song.contentHash ?? "")) throw unavailable();
    try {
      const root = await waitFor(realpath(configured), signal);
      const preview = await waitFor(libraryIndex(root), signal);
      const expectedKeys = registered.map(item => item.key).sort();
      const names = new Set([song.originalName, song.name].filter(value => typeof value === "string" && value.trim()));
      const candidates = preview.entries.filter(entry => names.has(entry.name));
      const verified = [];
      for (const entry of candidates) {
        const variants = Object.entries(entry.videoByTodView ?? {});
        if (JSON.stringify(variants.map(([key]) => key).sort()) !== JSON.stringify(expectedKeys)) continue;
        const files = new Map();
        for (const [key, path] of variants) {
          const actual = await waitFor(realpath(path), signal);
          if (!within(root, actual)) throw unavailable();
          const info = await waitFor(fileInfo(actual), signal);
          if (!info) throw unavailable();
          files.set(key, { path: actual, info });
        }
        // Older imports stored the DEFAULT file hash, not a variant-set hash.
        // Accept that legacy identity only for its identifiable stale cache,
        // with exact variant keys and all source clips in the same work folder.
        const legacy = song.sourceKind === "import" && registered.every(item =>
          cachedFaststartPath(resolvePath(item.path), song.contentHash, item.key));
        const primary = files.get("DEFAULT");
        let matched = legacy && primary && new Set([...files.values()].map(item => dirname(item.path))).size === 1
          && await waitFor(fingerprint(primary.path, primary.info), signal) === song.contentHash;
        if (!matched) {
          const hash = createHash("sha256");
          for (const [key, file] of [...files].sort(([a], [b]) => a.localeCompare(b, "en")))
            hash.update(`${key}\0${await waitFor(fingerprint(file.path, file.info), signal)}\0`, "utf8");
          matched = hash.digest("hex") === song.contentHash;
        }
        if (matched) verified.push(files.get(variantKey).path);
      }
      if (new Set(verified).size !== 1) throw unavailable();
      return verified[0];
    } catch { ensureActive(signal); throw unavailable(); }
  }
  resolvePreview.sourceFingerprint = async (song, variantKey, { signal } = {}) => {
    const path = await resolvePreview(song, variantKey, { originalSource: true, signal });
    const info = await waitFor(fileInfo(path), signal);
    if (!info) throw unavailable();
    const sha256 = await waitFor(fingerprint(path, info), signal);
    ensureActive(signal);
    return { path, sha256 };
  };
  resolvePreview.invalidate = () => {
    index = null;
    hashes.clear();
  };
  resolvePreview.close = () => {
    lifetime.abort();
    for (const controller of activeHashes) controller.abort();
    activeHashes.clear();
    resolvePreview.invalidate();
    return Promise.allSettled([...activeHashTasks]);
  };
  return resolvePreview;
}
