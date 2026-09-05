import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { describeSongMetadata, selectSongVariant, TIME_SLOTS } from "./song-metadata.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const NATIVE_MEDIA_SCHEMA_REVISION = 2_200_000_000;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const MIDI_RENDERING_DISABLED_MESSAGE = "MIDI 视频生成功能已移除；请导入已经生成完成的官方演奏 MP4，不支持自动人物演奏生成";

class MidiRouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "MidiRouteError";
    this.status = status;
    this.code = code;
  }
}

function routeError(status, code, message) {
  throw new MidiRouteError(status, code, message);
}

function decorateStoreError(error) {
  if (error.status) return error;
  const statusByCode = {
    UPLOAD_TOKEN_INVALID: 404,
    UPLOAD_TOKEN_USED: 409,
    UPLOAD_TOKEN_EXPIRED: 410,
    MIDI_TOO_LARGE: 413,
    MIDI_UPLOAD_NOT_READY: 409,
    MIDI_JOB_NOT_FOUND: 404,
    MIDI_JOB_ACTIVE: 409,
    MIDI_JOB_TRANSITION_INVALID: 409,
  };
  if (error.code && statusByCode[error.code]) error.status = statusByCode[error.code];
  return error;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) routeError(413, "MIDI_REQUEST_TOO_LARGE", "MIDI 请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    routeError(400, "MIDI_JSON_INVALID", "MIDI 请求 JSON 无效");
  }
}

function normalizedPath(pathname) {
  return pathname.startsWith("/toy/") ? pathname.slice(4) : pathname;
}

function requestBase(req) {
  const host = req.headers.host || "127.0.0.1:27149";
  return `http://${host}`;
}

function nativeNameKey(song) {
  return `oliviasoul_${String(song.id).replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function bodyJobId(body, url) {
  return String(
    body.jobId
    ?? body.generateJobId
    ?? body.id
    ?? url.searchParams.get("jobId")
    ?? url.searchParams.get("generateJobId")
    ?? url.searchParams.get("id")
    ?? "",
  ).trim();
}

function queryJobIds(url) {
  const values = [
    ...url.searchParams.getAll("jobId"),
    ...url.searchParams.getAll("jobIds"),
    ...url.searchParams.getAll("jobIds[]"),
    ...url.searchParams.getAll("generateJobId"),
    ...url.searchParams.getAll("generateJobIds"),
    ...url.searchParams.getAll("generateJobIds[]"),
  ];
  return values.flatMap(value => {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // Fall through to comma-separated compatibility.
      }
    }
    return trimmed.split(",").map(item => item.trim()).filter(Boolean);
  });
}

function formatJob(job, req) {
  if (!job) return null;
  const videoUrl = job.videoPath
    ? `${requestBase(req)}/toy/midi/jobs/${encodeURIComponent(job.id)}/video.mp4`
    : "";
  return {
    id: job.id,
    jobId: job.id,
    generateJobId: job.id,
    name: job.title,
    state: job.state,
    status: job.state,
    progress: job.progress,
    error: job.error || "",
    duration: job.durationUs ? job.durationUs / 1_000_000 : 0,
    durationUs: job.durationUs ?? 0,
    videoUrl,
    result: job.state === "completed" ? { videoUrl } : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function formatSong(song, req, nativePlayback = null) {
  const defaultFilename = nativePlayback?.files?.get("default")?.filename ?? "video.mp4";
  const fallback = selectSongVariant(song, null, null);
  const videoUrl = song.videoPath
    ? `${requestBase(req)}/toy/midi/songs/${encodeURIComponent(song.id)}/${encodeURIComponent(defaultFilename)}`
    : fallback.path ? `${requestBase(req)}/toy/midi/songs/${encodeURIComponent(song.id)}/${encodeURIComponent(defaultFilename)}?variant=${encodeURIComponent(fallback.key)}` : "";
  const duration = song.durationUs / 1_000_000;
  const metadata = describeSongMetadata(song, req);
  // The native player requires every slot, even when source metadata only
  // identifies a subset. Selection supplies safe fallbacks without inventing bindings.
  const slots = TIME_SLOTS.flatMap(tod => ["NI", "WI"].map(view => ({ tod, view })));
  const videoByTodView = slots.flatMap(({ tod, view }) => {
    const selected = selectSongVariant(song, tod, view);
    if (!selected.path) return [];
    const nativeFile = nativePlayback?.files?.get(selected.key);
    const filename = nativeFile?.filename ?? defaultFilename;
    const url = metadata.mappingStatus === "single" || selected.reason === "unconfirmed"
      ? videoUrl
      : `${requestBase(req)}/toy/midi/songs/${encodeURIComponent(song.id)}/${encodeURIComponent(filename)}?variant=${encodeURIComponent(selected.key)}`;
    return [{ tod, view, url, coverUrl: "", duration: Math.ceil(duration), size: nativeFile?.size ?? 0 }];
  });
  const performanceType = ["Solo", "PlaySing", "Instrumental"].includes(song.performanceType)
    ? song.performanceType
    : "Solo";
  const performanceTypeDisplayShortName = {
    Solo: "独奏",
    PlaySing: "弹唱",
    Instrumental: "伴奏",
  }[performanceType];
  return {
    id: song.id,
    // NutStudioPlugin deserializes this object before checking whether the
    // local media exists. A missing eventId aborts that native bridge call.
    eventId: song.id,
    userSongId: song.id,
    ...metadata,
    nameKey: nativePlayback?.nameKey ?? nativeNameKey(song),
    iconUrl: "",
    songId: song.id,
    performanceId: song.id,
    duration,
    videoDuration: duration,
    videoUrl,
    performanceType,
    performanceTypeDisplayName: performanceTypeDisplayShortName,
    performanceTypeDisplayShortName,
    // The native player selects one URL by the current time-of-day and view.
    // Unknown generic variants retain safe default playback; only named or
    // manually confirmed metadata establishes distinct time bindings.
    videoByTodView,
    nativePlaybackReady: nativePlayback?.ready === true,
    nativePlaybackError: nativePlayback?.error ?? null,
    sourceKind: song.sourceKind,
    createdAt: song.createdAt,
  };
}

async function receiveUpload(req, store, token) {
  const upload = store.getUploadByToken(token);
  if (!upload) routeError(404, "UPLOAD_TOKEN_INVALID", "上传凭据不存在");
  if (upload.consumedAt != null) routeError(409, "UPLOAD_TOKEN_USED", "该上传凭据已经使用");
  const extension = extname(upload.originalFilename).toLowerCase() === ".midi" ? ".midi" : ".mid";
  const inputPath = join(store.root, "inputs", `${token}${extension}`);
  await mkdir(join(store.root, "inputs"), { recursive: true });
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let file;
  let completed = false;
  try {
    file = await open(inputPath, "wx");
    for await (const chunk of req) {
      sizeBytes += chunk.length;
      if (sizeBytes > upload.maxBytes) {
        routeError(413, "MIDI_TOO_LARGE", `MIDI 文件不能超过 ${upload.maxBytes} 字节`);
      }
      hash.update(chunk);
      await file.write(chunk);
    }
    await file.close();
    file = null;
    const consumed = store.consumeUploadToken(token, {
      inputPath,
      sha256: hash.digest("hex"),
      sizeBytes,
    });
    completed = true;
    return { key: consumed.key, sizeBytes, sha256: consumed.sha256 };
  } catch (error) {
    throw decorateStoreError(error);
  } finally {
    await file?.close();
    if (!completed) await rm(inputPath, { force: true });
  }
}

export function createMidiRoutes({
  store,
  queue = { enqueue() {}, cancel() {} },
}) {
  if (!store) throw new TypeError("createMidiRoutes requires a MIDI store");

  return async function handleMidiRoute(req, url) {
    const path = normalizedPath(url.pathname);
    try {
      if (req.method === "POST" && path === "/genObjectUploadUrl") {
        routeError(410, "MIDI_RENDERING_DISABLED", MIDI_RENDERING_DISABLED_MESSAGE);
      }

      const uploadMatch = /^\/midi\/upload\/([^/]+)$/u.exec(path);
      if (req.method === "PUT" && uploadMatch) {
        routeError(410, "MIDI_RENDERING_DISABLED", MIDI_RENDERING_DISABLED_MESSAGE);
      }

      if (req.method === "POST" && path === "/midi/generate") {
        routeError(410, "MIDI_RENDERING_DISABLED", MIDI_RENDERING_DISABLED_MESSAGE);
      }

      if (req.method === "GET" && path === "/midi/getGenerateResult") {
        const id = bodyJobId({}, url);
        const job = store.getJob(id);
        if (!job) routeError(404, "MIDI_JOB_NOT_FOUND", "MIDI 生成任务不存在");
        return formatJob(job, req);
      }

      if (req.method === "GET" && path === "/midi/listJobs") {
        const results = store.listJobs().map(job => formatJob(job, req));
        return { results, list: results, total: results.length, dailyLimit: 0, generatedToday: 0 };
      }

      if ((req.method === "POST" || req.method === "GET") && path === "/midi/batchGetResult") {
        const body = req.method === "POST" ? await readJson(req) : {};
        const queryIds = queryJobIds(url);
        const ids = body.jobIds ?? body.generateJobIds ?? body.ids ?? queryIds;
        const requested = Array.isArray(ids) ? ids.map(String) : [];
        const results = requested
          .map(id => store.getJob(id))
          .filter(Boolean)
          .map(job => formatJob(job, req));
        return { results, list: results };
      }

      if (req.method === "POST" && path === "/midi/cancelGenerate") {
        const body = await readJson(req);
        const id = bodyJobId(body, url);
        let job = store.getJob(id);
        if (!job) routeError(404, "MIDI_JOB_NOT_FOUND", "MIDI 生成任务不存在");
        if (job.state === "queued") {
          job = store.transitionJob(id, "cancelled");
          await queue.cancel?.(id);
        } else if (!TERMINAL_STATES.has(job.state)) {
          job = store.requestCancellation(id);
          await queue.cancel?.(id);
        }
        return formatJob(job, req);
      }

      if (req.method === "POST" && path === "/midi/deleteJob") {
        const body = await readJson(req);
        const id = bodyJobId(body, url);
        return { jobId: id, deleted: store.deleteJob(id) };
      }

      if (req.method === "POST" && path === "/midi/importShareCode") {
        routeError(410, "MIDI_SHARE_CODE_RETIRED", "分享码在线下载功能已移除；请导入已经下载完成且包含 MP4 的官方作品目录");
      }

      if (req.method === "GET" && path === "/searchUserSongs") {
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 100)));
        const cursor = url.searchParams.get("cursor");
        const query = url.searchParams.get("query") ?? url.searchParams.get("keyword") ?? url.searchParams.get("search") ?? "";
        const page = store.pagePublishedUserSongs({ query, pageSize, cursor });
        const list = page.list.map(song => formatSong(song, req));
        return { ...page, revision: NATIVE_MEDIA_SCHEMA_REVISION + page.revision, list, results: list };
      }

      if (req.method === "POST" && path === "/deleteUserSong") {
        const body = await readJson(req);
        const id = String(body.userSongId ?? body.songId ?? body.id ?? "").trim();
        return { userSongId: id, deleted: store.deleteUserSong(id) };
      }

      return null;
    } catch (error) {
      throw decorateStoreError(error);
    }
  };
}
