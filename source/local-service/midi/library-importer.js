import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkMigrationCapacity } from "../storage-paths.js";
import { normalizePerformanceType } from "./store.js";

const MIDI_EXTENSIONS = new Set([".mid", ".midi"]);
const VIDEO_EXTENSIONS = new Set([".mp4"]);
const MAX_SCAN_FILES = 20_000;
const MAX_REFERENCE_SOURCE_SIGNATURES = MAX_SCAN_FILES;
const referenceSourceSignatures = new Map();
let referenceSignatureRoot = null;

export class LibraryImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LibraryImportError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LibraryImportError(code, message);
}

function within(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function resolveLibraryPath(root, value) {
  const candidate = resolve(root, String(value ?? ""));
  if (!within(root, candidate)) fail("LIBRARY_PATH_OUTSIDE_ROOT", `曲库文件越过所选目录：${value}`);
  return candidate;
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value.trim());
  return cells;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u).filter(line => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(value => value.trim());
  return lines.slice(1).map(line => Object.fromEntries(
    parseCsvLine(line).map((value, index) => [headers[index], value]),
  ));
}

function variantKeyFromFilename(path) {
  const stem = basename(path, extname(path)).toUpperCase();
  const match = /(TOD(?:1200|1730|2000))(?:[_-](NI|WI))?(?:[_-]([LR]))?/u.exec(stem);
  if (!match) return "DEFAULT";
  return [match[1], match[2], match[3]].filter(Boolean).join("_");
}

function variantKeyFromManifest(record, videoPath) {
  if (record.variant) return String(record.variant).trim().toUpperCase();
  const tod = String(record.tod ?? "").trim().toUpperCase();
  const view = String(record.view ?? "").trim().toUpperCase();
  if (tod || view) return [tod, view].filter(Boolean).join("_");
  return variantKeyFromFilename(videoPath);
}

function choosePreferredVideo(variants) {
  const keys = Object.keys(variants).sort((left, right) => left.localeCompare(right, "en"));
  const preferred = [
    "TOD1730_NI_L",
    "TOD1730_NI",
    "TOD1730",
    "DEFAULT",
  ];
  for (const key of preferred) if (variants[key]) return variants[key];
  return keys.length ? variants[keys[0]] : null;
}

async function collectFiles(root, output, depth = 0) {
  if (depth > 6) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    if (output.length >= MAX_SCAN_FILES) fail("LIBRARY_TOO_MANY_FILES", `曲库文件超过 ${MAX_SCAN_FILES} 个`);
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await collectFiles(path, output, depth + 1);
    else if (entry.isFile()) output.push(path);
  }
}

async function collectPerformanceDirectories(root, output, depth = 0) {
  if (depth > 6) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (/^midi_[^\\/]+$/iu.test(entry.name)) {
      output.push(path);
      if (output.length >= MAX_SCAN_FILES)
        fail("LIBRARY_TOO_MANY_FILES", `曲库演奏目录超过 ${MAX_SCAN_FILES} 个`);
      continue;
    }
    await collectPerformanceDirectories(path, output, depth + 1);
  }
}

function buildFallbackEntry(name, files) {
  const midiPaths = files.filter(path => MIDI_EXTENSIONS.has(extname(path).toLowerCase())).sort();
  const videoPaths = files.filter(path => VIDEO_EXTENSIONS.has(extname(path).toLowerCase())).sort();
  const videoByTodView = {};
  for (const path of videoPaths) {
    let key = variantKeyFromFilename(path);
    let suffix = 2;
    while (videoByTodView[key]) key = `${variantKeyFromFilename(path)}_${suffix++}`;
    videoByTodView[key] = path;
  }
  return {
    name,
    performanceType: "Solo",
    midiPath: midiPaths[0] ?? null,
    videoPath: choosePreferredVideo(videoByTodView),
    videoByTodView,
    warnings: midiPaths.length > 1 ? [`发现 ${midiPaths.length} 个 MIDI，默认使用 ${basename(midiPaths[0])}`] : [],
  };
}

function manifestEntries(root, records) {
  const grouped = new Map();
  for (const record of records) {
    const name = String(record.name ?? record.title ?? "").trim();
    if (!name) fail("LIBRARY_MANIFEST_INVALID", "曲库清单中的 name 不能为空");
    let entry = grouped.get(name);
    if (!entry) {
      entry = { name, performanceType: "Solo", midiPath: null, videoPath: null, videoByTodView: {}, warnings: [] };
      grouped.set(name, entry);
    }
    const declaredType = record.performanceType ?? record.performance_type ?? record.mode;
    if (declaredType != null && String(declaredType).trim())
      entry.performanceType = normalizePerformanceType(declaredType);
    if (record.midi) entry.midiPath = resolveLibraryPath(root, record.midi);
    if (record.video) {
      const videoPath = resolveLibraryPath(root, record.video);
      entry.videoByTodView[variantKeyFromManifest(record, videoPath)] = videoPath;
    }
    if (record.variants && typeof record.variants === "object") {
      for (const [key, value] of Object.entries(record.variants))
        entry.videoByTodView[String(key).toUpperCase()] = resolveLibraryPath(root, value);
    }
  }
  return [...grouped.values()].map(entry => ({
    ...entry,
    videoPath: choosePreferredVideo(entry.videoByTodView),
  }));
}

function performanceDirectoryForPath(root, path) {
  if (!path) return null;
  let current = dirname(path);
  while (within(root, current) && resolve(current) !== resolve(root)) {
    if (/^midi_[^\\/]+$/iu.test(basename(current))) return resolve(current);
    current = dirname(current);
  }
  return null;
}

async function mergeUnlistedPerformanceDirectories(root, entries, source) {
  const represented = new Set();
  for (const entry of entries) {
    for (const path of [entry.midiPath, entry.videoPath, ...Object.values(entry.videoByTodView)]) {
      const directory = performanceDirectoryForPath(root, path);
      if (directory) represented.add(directory.toLocaleLowerCase());
    }
  }
  const performanceDirectories = [];
  await collectPerformanceDirectories(root, performanceDirectories);
  let added = 0;
  for (const directory of performanceDirectories) {
    if (represented.has(resolve(directory).toLocaleLowerCase())) continue;
    const files = [];
    await collectFiles(directory, files);
    const relativeParts = relative(root, directory).split(sep);
    const category = relativeParts.length > 1 ? relativeParts[0] : "个人上传";
    const entry = buildFallbackEntry(`${category} · ${basename(directory)}`, files);
    if (!entry.midiPath && !entry.videoPath) continue;
    entries.push(entry);
    represented.add(resolve(directory).toLocaleLowerCase());
    added += 1;
  }
  return {
    root,
    source: added ? `${source}+performance-folders` : source,
    entries,
    warnings: added ? [`发现 ${added} 个清单外的新演奏目录`] : [],
  };
}

export async function scanPerformanceLibrary(libraryRoot) {
  const root = resolve(String(libraryRoot ?? ""));
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    fail("LIBRARY_ROOT_NOT_FOUND", "曲库目录不存在");
  }
  if (!rootInfo.isDirectory()) fail("LIBRARY_ROOT_INVALID", "曲库路径不是文件夹");

  const jsonManifest = join(root, "library.json");
  try {
    const payload = JSON.parse(await readFile(jsonManifest, "utf8"));
    const records = Array.isArray(payload) ? payload : payload.songs;
    if (!Array.isArray(records)) fail("LIBRARY_MANIFEST_INVALID", "library.json 必须包含 songs 数组");
    const entries = manifestEntries(root, records);
    return await mergeUnlistedPerformanceDirectories(root, entries, "manifest-json");
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof LibraryImportError) throw error;
      fail("LIBRARY_MANIFEST_INVALID", `library.json 无法解析：${error.message}`);
    }
  }

  const csvManifest = join(root, "library.csv");
  try {
    const records = parseCsv(await readFile(csvManifest, "utf8"));
    const entries = manifestEntries(root, records);
    return await mergeUnlistedPerformanceDirectories(root, entries, "manifest-csv");
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof LibraryImportError) throw error;
      fail("LIBRARY_MANIFEST_INVALID", `library.csv 无法解析：${error.message}`);
    }
  }

  const performanceDirectories = [];
  await collectPerformanceDirectories(root, performanceDirectories);
  if (performanceDirectories.length) {
    const entries = [];
    for (const directory of performanceDirectories) {
      const files = [];
      await collectFiles(directory, files);
      const relativeParts = relative(root, directory).split(sep);
      const category = relativeParts.length > 1 ? relativeParts[0] : "个人上传";
      const entry = buildFallbackEntry(`${category} · ${basename(directory)}`, files);
      if (entry.midiPath || entry.videoPath) entries.push(entry);
    }
    return { root, source: "performance-folders", entries, warnings: [] };
  }

  const topLevel = await readdir(root, { withFileTypes: true });
  const entries = [];
  for (const directory of topLevel.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())) {
    const files = [];
    await collectFiles(join(root, directory.name), files);
    const entry = buildFallbackEntry(directory.name, files);
    if (entry.midiPath || entry.videoPath) entries.push(entry);
  }
  for (const file of topLevel.filter(entry => entry.isFile())) {
    const extension = extname(file.name).toLowerCase();
    if (!MIDI_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) continue;
    const path = join(root, file.name);
    entries.push(buildFallbackEntry(basename(file.name, extension), [path]));
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { root, source: "folders", entries, warnings: [] };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicCopy(source, destination, hashFile = sha256File) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    await copyFile(source, temporary);
    if (await hashFile(source) !== await hashFile(temporary))
      fail("LIBRARY_COPY_HASH_MISMATCH", `复制校验失败：${basename(source)}`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function normalizedName(value) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function referenceSourceKey(libraryRoot, name) {
  return `${resolve(libraryRoot)}\u0000${normalizedName(name)}`;
}

async function referenceSourceSignature(libraryRoot, entry) {
  if (!entry?.videoPath) return null;
  const variants = Object.keys(entry.videoByTodView ?? {}).length
    ? Object.entries(entry.videoByTodView)
    : [["DEFAULT", entry.videoPath]];
  const parts = [];
  for (const [key, path] of variants.sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!within(libraryRoot, path)) return null;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0) return null;
      parts.push(`${key}\u0000${resolve(path)}\u0000${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`);
    } catch { return null; }
  }
  return parts.join("\u0001");
}

async function isKnownUnchangedReference(libraryRoot, entry, songsByKnownName, jobNames) {
  const nameKey = normalizedName(entry.name);
  if (jobNames.has(nameKey)) return true;
  const songs = songsByKnownName.get(nameKey);
  if (!songs?.length) return false;
  const signature = await referenceSourceSignature(libraryRoot, entry);
  const cached = signature && referenceSourceSignatures.get(referenceSourceKey(libraryRoot, entry.name));
  return Boolean(cached && cached.signature === signature && songs.some(song => song.contentHash === cached.contentHash));
}

function rememberReferenceSource(libraryRoot, entry, contentHash, signature) {
  if (!signature || !contentHash) return;
  const root = resolve(libraryRoot);
  if (referenceSignatureRoot !== root) {
    referenceSourceSignatures.clear();
    referenceSignatureRoot = root;
  }
  const key = referenceSourceKey(root, entry.name);
  if (!referenceSourceSignatures.has(key) && referenceSourceSignatures.size >= MAX_REFERENCE_SOURCE_SIGNATURES) return;
  referenceSourceSignatures.set(key, { signature, contentHash });
}

function matchesLegacyImportedSource(store, song, entry, variants, variantHashes) {
  if (song.sourceKind !== "import" || !song.contentHash || !variantHashes.get("DEFAULT")) return false;
  if (song.contentHash !== variantHashes.get("DEFAULT")) return false;
  if (normalizedName(song.originalName ?? song.name) !== normalizedName(entry.name)) return false;
  const expectedKeys = variants.map(([key]) => key).sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(variants.map(([, path]) => dirname(resolve(path)))).size !== 1) return false;
  const storedVariants = Object.entries(song.videoByTodView ?? {});
  if (storedVariants.map(([key]) => key).sort((left, right) => left.localeCompare(right, "en")).join("\u0000") !== expectedKeys.join("\u0000")) return false;
  return storedVariants.every(([key, path]) => {
    try {
      const actual = store.resolvePath(path).replaceAll("\\", "/").replaceAll(/\/{2,}/gu, "/");
      return actual.endsWith(`/.faststart-cache/${song.contentHash}/${key}.mp4`);
    } catch { return false; }
  });
}

export async function importPerformanceLibrary(preview, {
  store,
  queue,
  mode = "copy",
  managedRoot,
  probeVideoDurationUs = null,
  hashFile = sha256File,
  getFreeBytes = async path => {
    const info = await statfs(path, { bigint: true });
    const available = info.bavail * info.bsize;
    return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
  },
}) {
  if (!store || !queue) throw new TypeError("Library import requires a store and queue");
  if (!preview?.root || !Array.isArray(preview.entries)) fail("LIBRARY_PREVIEW_INVALID", "曲库预览无效");
  if (mode !== "reference" && mode !== "copy") fail("LIBRARY_MODE_INVALID", "导入模式无效");
  if (mode === "copy" && !managedRoot) fail("LIBRARY_TARGET_REQUIRED", "尚未取得游戏设置的官方作品保存路径");
  const effectiveMode = mode;
  const managedLibraryRoot = managedRoot ? resolve(managedRoot) : "";
  if (mode === "copy") await mkdir(managedLibraryRoot, { recursive: true });
  const libraryRoot = resolve(preview.root);
  const existingSongs = store.listUserSongs();
  const songsByKnownName = new Map();
  for (const song of existingSongs) {
    for (const name of [song.name, song.originalName]) {
      if (typeof name !== "string" || !name.trim()) continue;
      const key = normalizedName(name);
      const songs = songsByKnownName.get(key) ?? [];
      songs.push(song);
      songsByKnownName.set(key, songs);
    }
  }
  const jobNames = new Set();
  for (const job of store.listJobs()) {
    if (typeof job.title === "string" && job.title.trim()) jobNames.add(normalizedName(job.title));
  }
  const existingHashes = new Set(existingSongs.map(song => song.contentHash).filter(Boolean));
  for (const job of store.listJobs()) {
    const hash = store.getUploadByKey(job.uploadKey)?.sha256;
    if (hash) existingHashes.add(hash);
  }

  if (mode === "copy") {
    const copyHashes = new Set();
    let requiredBytes = 0;
    for (const entry of preview.entries) {
      if (!entry.videoPath || await isKnownUnchangedReference(libraryRoot, entry, songsByKnownName, jobNames)) continue;
      const variants = Object.keys(entry.videoByTodView ?? {}).length
        ? Object.values(entry.videoByTodView)
        : [entry.videoPath];
      for (const path of [...variants, entry.midiPath].filter(Boolean)) {
        if (!within(libraryRoot, path)) fail("LIBRARY_PATH_OUTSIDE_ROOT", `曲目 ${entry.name} 的文件越过所选目录`);
        const hash = await hashFile(path);
        if (copyHashes.has(hash)) continue;
        copyHashes.add(hash);
        requiredBytes += (await stat(path)).size;
      }
    }
    const capacity = checkMigrationCapacity({
      requiredBytes,
      freeBytes: await getFreeBytes(managedLibraryRoot),
    });
    if (!capacity.sufficient) {
      const error = new LibraryImportError("LIBRARY_INSUFFICIENT_SPACE", "目标磁盘空间不足，未复制任何作品");
      Object.assign(error, capacity);
      throw error;
    }
  }

  const details = [];
  let imported = 0;
  let skipped = 0;
  for (const entry of preview.entries) {
    if (await isKnownUnchangedReference(libraryRoot, entry, songsByKnownName, jobNames)) {
      skipped += 1;
      details.push({ name: entry.name, state: "skipped", reason: "duplicate" });
      continue;
    }
    const hashSource = entry.videoPath ?? entry.midiPath;
    if (!hashSource || !within(libraryRoot, hashSource)) {
      fail("LIBRARY_PATH_OUTSIDE_ROOT", `曲目 ${entry.name} 的文件越过所选目录`);
    }

    if (entry.videoPath) {
      const importId = randomUUID();
      const variants = Object.keys(entry.videoByTodView).length
        ? Object.entries(entry.videoByTodView)
        : [["DEFAULT", entry.videoPath]];
      const beforeSourceSignature = await referenceSourceSignature(libraryRoot, entry);
      let durationUs = 0;
      const contentHashBuilder = createHash("sha256");
      const variantHashes = new Map();
      try {
        if (typeof probeVideoDurationUs !== "function") throw new Error("未配置 MP4 媒体校验器");
        for (const [key, source] of variants.sort(([left], [right]) => left.localeCompare(right, "en"))) {
          if (!within(libraryRoot, source)) fail("LIBRARY_PATH_OUTSIDE_ROOT", `曲目 ${entry.name} 的视频越过所选目录`);
          const info = await stat(source);
          if (!info.isFile() || info.size <= 0) throw new Error("MP4 文件为空");
          const variantDuration = await probeVideoDurationUs(source);
          if (!Number.isSafeInteger(variantDuration) || variantDuration <= 0) throw new Error("视频没有有效时长");
          if (source === entry.videoPath || durationUs === 0) durationUs = variantDuration;
          const sourceHash = await hashFile(source);
          variantHashes.set(key, sourceHash);
          contentHashBuilder.update(`${key}\u0000${sourceHash}\u0000`, "utf8");
        }
      } catch (error) {
        skipped += 1;
        details.push({
          name: entry.name,
          state: "skipped",
          reason: "invalid-video",
          message: error instanceof Error ? error.message : "视频校验失败",
        });
        continue;
      }
      const contentHash = contentHashBuilder.digest("hex");
      const afterSourceSignature = await referenceSourceSignature(libraryRoot, entry);
      if (!beforeSourceSignature || beforeSourceSignature !== afterSourceSignature) {
        skipped += 1;
        details.push({ name: entry.name, state: "skipped", reason: "source-changed" });
        continue;
      }
      const matchingSong = songsByKnownName.get(normalizedName(entry.name))?.find(song => song.contentHash === contentHash);
      const legacySong = songsByKnownName.get(normalizedName(entry.name))?.find(song =>
        matchesLegacyImportedSource(store, song, entry, variants, variantHashes));
      if (existingHashes.has(contentHash)) {
        if (matchingSong) rememberReferenceSource(libraryRoot, entry, matchingSong.contentHash, afterSourceSignature);
        skipped += 1;
        details.push({ name: entry.name, state: "skipped", reason: "duplicate" });
        continue;
      }
      if (legacySong) {
        rememberReferenceSource(libraryRoot, entry, legacySong.contentHash, afterSourceSignature);
        skipped += 1;
        details.push({ name: entry.name, state: "skipped", reason: "duplicate" });
        continue;
      }
      let midiPath = entry.midiPath;
      let videoPath = entry.videoPath;
      let videoByTodView = Object.fromEntries(variants);
      if (mode === "reference") {
        store.upsertUserSong({
          name: entry.name,
          sourceKind: "official-import",
          midiPath,
          videoPath,
          durationUs,
          contentHash,
          performanceType: entry.performanceType,
          videoByTodView,
          externalRoot: libraryRoot,
        });
        rememberReferenceSource(libraryRoot, entry, contentHash, afterSourceSignature);
        imported += 1;
        existingHashes.add(contentHash);
        details.push({ name: entry.name, state: "registered", mode: effectiveMode });
        continue;
      }
      videoPath = null;
      videoByTodView = {};
      const stagingRoot = join(dirname(managedLibraryRoot), ".staging", importId);
      const targetRoot = join(managedLibraryRoot, importId);
      await rm(stagingRoot, { recursive: true, force: true });
      try {
        const copiedVariants = {};
        for (const [key, source] of variants) {
          const safeKey = String(key).replace(/[^A-Za-z0-9_-]+/gu, "_") || "DEFAULT";
          const destination = join(stagingRoot, `${safeKey}${extname(source).toLowerCase()}`);
          await atomicCopy(source, destination, hashFile);
          copiedVariants[key] = destination;
          if (source === entry.videoPath) videoPath = destination;
        }
        videoByTodView = copiedVariants;
        videoPath ??= Object.values(copiedVariants)[0];
        if (entry.midiPath) {
          midiPath = join(stagingRoot, `score${extname(entry.midiPath).toLowerCase()}`);
          await atomicCopy(entry.midiPath, midiPath, hashFile);
        }
        await rename(stagingRoot, targetRoot);
        const remap = path => join(targetRoot, basename(path));
        videoPath = remap(videoPath);
        videoByTodView = Object.fromEntries(Object.entries(videoByTodView).map(([key, path]) => [key, remap(path)]));
        if (midiPath) midiPath = remap(midiPath);
        store.upsertUserSong({
          name: entry.name,
          sourceKind: "official-import",
          midiPath,
          videoPath,
          durationUs,
          contentHash,
          performanceType: entry.performanceType,
          videoByTodView,
          externalRoot: managedLibraryRoot,
        });
        rememberReferenceSource(libraryRoot, entry, contentHash, afterSourceSignature);
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(targetRoot, { recursive: true, force: true });
        throw error;
      }
      imported += 1;
      existingHashes.add(contentHash);
      details.push({ name: entry.name, state: "registered", mode: effectiveMode });
      continue;
    }

    skipped += 1;
    details.push({ name: entry.name, state: "skipped", reason: "missing-official-video", message: "缺少官方生成的视频" });
  }
  return { imported, skipped, total: preview.entries.length, mode: effectiveMode, details };
}
