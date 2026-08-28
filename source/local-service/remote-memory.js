import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeSoulBundle } from "./soul-bundle.js";

const MAX_REMOTE_VIDEO_BYTES = 512 * 1024 * 1024;
const RETRY_DELAYS_MS = [500, 1500, 3000];
const REQUEST_HEADER_NAMES = new Set([
  "x-token", "x-uid", "x-bundle_id", "x-client_type", "x-platform", "x-device_id",
  "x-device_model", "x-language", "x-pkg_version", "x-sys_version", "x-lifecycle_id",
]);

function cancelledError() {
  return Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
}

function retryable(error) {
  if (error.code === "CANCELLED" || error.name === "AbortError") return false;
  if (error.retryable) return true;
  const status = Number(error.status);
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
  const httpStatus = Number(/\bHTTP\s+(\d{3})\b/iu.exec(error.message)?.[1]);
  if (httpStatus) return httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500;
  return error instanceof TypeError ||
    /terminated|fetch failed|socket|ECONN|ETIMEDOUT|EPIPE|network/iu.test(`${error.message} ${error.cause?.code ?? ""}`);
}

function retryDelay(milliseconds, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    let timer;
    const abort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    timer = setTimeout(complete, milliseconds);
    if (!signal) return;
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function retryNetwork(point, signal, action, delays = RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if (attempt >= delays.length || !retryable(error)) throw error;
      console.warn(`[remote-retry] point=${point} retry=${attempt + 1}/${delays.length} reason=${error.message}`);
      await retryDelay(delays[attempt], signal);
    }
  }
}

function snapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    letters: job.letters,
    videos: job.videos,
    skipped: job.skipped,
    error: job.error,
    readyToSave: job.state === "done",
    modelState: job.modelState,
    modelPercent: job.modelPercent,
    modelMessage: job.modelMessage,
  };
}

function remoteStageName(stage) {
  if (stage.startsWith("video_")) return "视频转写";
  return {
    queued: "任务启动",
    reading_session: "读取官方登录信息",
    fetching_letters: "拉取信件列表",
    fetching_details: "读取信件详情",
    downloading_videos: "下载远端视频",
    packaging: "封装记忆文件",
  }[stage] ?? "远端记忆导入";
}

function jsonObjects(text) {
  const values = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") quoted = false;
        continue;
      }
      if (char === "\"") quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Chromium LevelDB values may contain unrelated binary records.
        }
        break;
      }
    }
  }
  return values;
}

function findClientConfig(value) {
  if (!value) return null;
  if (typeof value === "string") {
    if (!value.includes("toyApiUrl")) return null;
    try {
      return findClientConfig(JSON.parse(value));
    } catch {
      for (const parsed of jsonObjects(value)) {
        const found = findClientConfig(parsed);
        if (found) return found;
      }
      return null;
    }
  }
  if (typeof value !== "object") return null;
  let appConf = value.appConf ?? value.app_conf;
  let apiHeaders = value.apiHeaders ?? value.api_headers;
  if (typeof appConf === "string")
    try { appConf = JSON.parse(appConf); } catch {}
  if (typeof apiHeaders === "string")
    try { apiHeaders = JSON.parse(apiHeaders); } catch {}
  const toyApiUrl = appConf?.toyApiUrl ?? appConf?.toy_api_url;
  if (toyApiUrl && apiHeaders) return { toyApiUrl: String(toyApiUrl), apiHeaders };
  for (const child of Object.values(value)) {
    const found = findClientConfig(child);
    if (found) return found;
  }
  return null;
}

function jsonStringProperty(text, name) {
  const match = new RegExp(`"${name}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u").exec(text);
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return "";
  }
}

function findTruncatedClientConfig(value) {
  if (!value) return null;
  if (typeof value === "string") {
    if (!value.includes("toyApiUrl") || !value.includes("apiHeaders")) return null;
    const toyApiUrl = jsonStringProperty(value, "toyApiUrl");
    const headersStart = value.indexOf("\"apiHeaders\"");
    const headerText = value.slice(headersStart);
    const apiHeaders = {};
    for (const name of [
      "x-bundle_id", "x-client_type", "x-device_id", "x-device_name", "x-device_model",
      "x-device_os", "x-language", "x-pkg_version", "x-sys_version",
    ]) {
      const headerValue = jsonStringProperty(headerText, name);
      if (headerValue) apiHeaders[name] = headerValue;
    }
    return toyApiUrl && apiHeaders["x-device_id"] ? { toyApiUrl, apiHeaders } : null;
  }
  if (typeof value !== "object") return null;
  for (const child of Object.values(value)) {
    const found = findTruncatedClientConfig(child);
    if (found) return found;
  }
  return null;
}

async function readClientConfig(logsPath) {
  const names = (await readdir(logsPath)).filter(name => /^Olivia(?:\.\d+)?\.log$/iu.test(name));
  const files = await Promise.all(names.map(async name => {
    const path = join(logsPath, name);
    return { path, modified: (await stat(path)).mtimeMs };
  }));
  files.sort((left, right) => right.modified - left.modified);
  for (const file of files) {
    const content = await readFile(file.path, "utf8");
    const lines = content.split(/\r?\n/u).filter(line => line.includes("toyApiUrl") && line.includes("apiHeaders")).reverse();
    for (const line of lines)
      for (const parsed of jsonObjects(line)) {
      const config = findClientConfig(parsed) ?? findTruncatedClientConfig(parsed);
      if (!config) continue;
      const url = new URL(config.toyApiUrl);
      if (url.protocol !== "https:" || !/(^|\.)olivia\.miyoushe\.com$/iu.test(url.hostname))
        throw new Error("官方客户端 API 地址未通过安全校验");
      const allowedHeaders = {};
      for (const [name, headerValue] of Object.entries(config.apiHeaders))
        if (/^x-(bundle_id|client_type|device_id|device_name|device_model|device_os|language|pkg_version|sys_version)$/iu.test(name))
          allowedHeaders[name.toLowerCase()] = String(headerValue);
      if (!allowedHeaders["x-device_id"]) throw new Error("官方客户端配置缺少设备 ID");
      return { apiBase: `${url.href.replace(/\/+$/u, "")}/toy`, apiHeaders: allowedHeaders };
      }
  }
  throw new Error("请先在官方游戏中打开一次信箱");
}

function collectRequestHeaders(value, headers) {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    const normalized = name.toLowerCase();
    if (REQUEST_HEADER_NAMES.has(normalized) && typeof child === "string")
      headers[normalized] = child;
    else
      collectRequestHeaders(child, headers);
  }
}

export async function readOfficialRequestContext(logsPath) {
  const config = await readClientConfig(logsPath);
  const names = (await readdir(logsPath)).filter(name => /^Olivia(?:\.\d+)?\.log$/iu.test(name));
  const files = await Promise.all(names.map(async name => {
    const path = join(logsPath, name);
    return { path, modified: (await stat(path)).mtimeMs };
  }));
  files.sort((left, right) => right.modified - left.modified);
  for (const file of files) {
    const lines = (await readFile(file.path, "utf8")).split(/\r?\n/u).reverse();
    for (const line of lines) {
      if (!line.includes("/letter/list") || !line.includes("x-token")) continue;
      for (const parsed of jsonObjects(line)) {
        const apiHeaders = {};
        collectRequestHeaders(parsed, apiHeaders);
        if (apiHeaders["x-token"] && apiHeaders["x-uid"])
          return { ...config, apiHeaders };
      }
    }
  }
  throw new Error("请先在官方游戏中打开一次信箱");
}

function value(source, camel, snake = camel) {
  return source?.[camel] ?? source?.[snake];
}

function unwrap(body) {
  const code = body?.code ?? body?.retcode ?? 0;
  if (code !== 0) throw new Error(body?.message ?? body?.msg ?? `远端接口错误：${code}`);
  return body?.data ?? body;
}

function contentMd5(incoming, reply) {
  return createHash("md5").update(`${incoming.trim()}\n---\n${reply.trim()}`, "utf8").digest("hex");
}

function remoteDate(timestamp) {
  if (!timestamp) return "";
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toLocaleDateString("sv-SE");
}

function remoteTime(timestamp) {
  if (!timestamp) return "12:00";
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const value = new Date(milliseconds);
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

async function validateRemoteVideo(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    if ((await handle.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("远端视频不是有效 MP4");
  } finally {
    await handle.close();
  }
}

export class RemoteMemoryJobs {
  constructor({
    appData,
    dataDir,
    engine,
    fetchImpl = fetch,
    readSession,
    remoteBase,
    retryDelays,
  }) {
    const officialRoot = join(appData, "..", "miHoYo", "Olivia-steam");
    this.logsPath = join(officialRoot, "logs");
    this.tempDir = join(dataDir, "tmp", "remote-export");
    this.engine = engine;
    this.fetch = fetchImpl;
    this.readSession = readSession ?? (() => readOfficialRequestContext(this.logsPath));
    this.remoteBase = remoteBase;
    this.retryDelays = retryDelays ?? RETRY_DELAYS_MS;
    this.jobs = new Map();
    this.active = null;
  }

  async request(base, path, headers, query = {}, signal) {
    const url = new URL(`${base}${path}`);
    for (const [key, item] of Object.entries(query))
      if (item !== undefined && item !== null && item !== "") url.searchParams.set(key, String(item));
    return retryNetwork(`api:${path}`, signal, async () => {
      const response = await this.fetch(url, { headers, signal });
      let body;
      try {
        body = await response.json();
      } catch {
        const error = new Error(`远端接口返回异常：HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.ok;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`远端接口请求失败：HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return unwrap(body);
    }, this.retryDelays);
  }

  async downloadVideo(urlValue, path, signal, onProgress) {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || !/(^|\.)(miyoushe\.com|mihoyo\.com|hoyoverse\.com)$/iu.test(url.hostname))
      throw new Error("远端视频地址不在允许域名内");
    await rm(path, { force: true });
    return retryNetwork("video-download", signal, async () => {
      await this.downloadVideoOnce(url, path, signal, onProgress);
    }, this.retryDelays);
  }

  async downloadVideoOnce(url, path, signal, onProgress) {
    let offset = 0;
    try {
      offset = (await stat(path)).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const requestHeaders = { "Accept-Encoding": "identity" };
    if (offset) requestHeaders.Range = `bytes=${offset}-`;
    const response = await this.fetch(url, { headers: requestHeaders, signal });
    if (response.status === 416 && offset) {
      await validateRemoteVideo(path);
      onProgress(1);
      return;
    }
    if (!response.ok || !response.body) throw new Error(`远端视频下载失败：HTTP ${response.status}`);
    const resumed = offset > 0 && response.status === 206;
    if (offset && !resumed) {
      await rm(path, { force: true });
      offset = 0;
    }
    const contentRange = /^bytes\s+\d+-\d+\/(\d+)$/iu.exec(response.headers.get("content-range") ?? "");
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const total = Number(contentRange?.[1] ?? (contentLength ? offset + contentLength : 0));
    if (total > MAX_REMOTE_VIDEO_BYTES) throw new Error("远端视频超过 512 MB");
    const output = await open(path, resumed ? "a" : "w");
    let received = offset;
    if (total) onProgress(received / total);
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) throw Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
        received += chunk.length;
        if (received > MAX_REMOTE_VIDEO_BYTES) throw new Error("远端视频超过 512 MB");
        await output.write(chunk);
        if (total) onProgress(received / total);
      }
    } finally {
      await output.close();
    }
    if (total && received < total) {
      const error = new Error(`远端视频下载中断：${received}/${total} 字节`);
      error.retryable = true;
      throw error;
    }
    await validateRemoteVideo(path);
  }

  async execute(job) {
    await mkdir(job.workDir, { recursive: true });
    try {
      Object.assign(job, { stage: "reading_session", percent: 1, message: "正在读取官方信箱请求" });
      const context = await this.readSession();
      const apiBase = context.apiBase ?? this.remoteBase;
      if (!apiBase) throw new Error("未找到官方客户端 API 地址");
      const headers = {
        ...(context.apiHeaders ?? {}),
        "Content-Type": "application/json",
      };
      if (!headers["x-token"] || !headers["x-uid"]) throw new Error("请先在官方游戏中打开一次信箱");
      Object.assign(job, { stage: "fetching_letters", percent: 4, message: "正在验证远端登录状态" });
      const profile = await this.request(apiBase, "/getUserInfo", headers, {}, job.controller.signal);
      const uid = String(value(profile, "uid") ?? "");
      if (!uid) throw new Error("远端登录状态没有 UID");
      headers["x-uid"] = uid;
      const summaries = [];
      let cursor;
      do {
        const page = await this.request(
          apiBase,
          "/letter/list",
          headers,
          { cursor, page_size: 80 },
          job.controller.signal,
        );
        const list = value(page, "list") ?? [];
        if (!Array.isArray(list)) throw new Error("远端信件列表格式不正确");
        summaries.push(...list);
        cursor = value(page, "nextCursor", "next_cursor");
        Object.assign(job, {
          percent: Math.min(14, 5 + summaries.length),
          message: `正在拉取远端信件列表：${summaries.length} 封`,
        });
        if (!value(page, "hasMore", "has_more")) break;
      } while (cursor !== undefined && cursor !== null);
      const records = [];
      for (let index = 0; index < summaries.length; index++) {
        if (job.controller.signal.aborted) throw Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
        const letterId = String(value(summaries[index], "letterId", "letter_id") ?? "");
        if (!letterId) throw new Error("远端信件缺少 ID");
        job.stage = "fetching_details";
        const detail = await this.request(
          apiBase,
          "/letter/detail",
          headers,
          { letter_id: letterId },
          job.controller.signal,
        );
        const incoming = String(value(detail, "content") ?? "").trim();
        const remoteReply = String(value(detail, "replyText", "reply_text") ?? "").trim();
        const videoUrl = String(value(detail, "replyVideoUrl", "reply_video_url") ?? "").trim();
        if (!remoteReply && !videoUrl) {
          job.skipped++;
          continue;
        }
        let videoPath = "";
        if (videoUrl) {
          job.stage = "downloading_videos";
          videoPath = join(job.workDir, `${letterId.replace(/[^a-zA-Z0-9_-]/gu, "_")}.mp4`);
          await this.downloadVideo(videoUrl, videoPath, job.controller.signal, progress => {
            job.percent = 15 + Math.floor((index + progress) / Math.max(1, summaries.length) * 30);
            job.message = `正在下载远端视频：${index + 1}/${summaries.length}`;
          });
        }
        records.push({
          letterId,
          incoming,
          reply: remoteReply,
          videoPath,
          createdAt: Number(value(detail, "createdAt", "created_at") ?? value(summaries[index], "createdAt", "created_at") ?? 0),
        });
        job.percent = 15 + Math.floor((index + 1) / Math.max(1, summaries.length) * 30);
        job.message = `正在读取信件详情：${index + 1}/${summaries.length}`;
      }
      delete headers["x-token"];
      const videos = records.filter(record => record.videoPath);
      job.videos = videos.length;
      const pendingVideos = videos.filter(record => !record.reply);
      const localProgress = pendingVideos.map(() => 0);
      const organizeProgress = pendingVideos.map(() => 0);
      let pipelineError;
      const organizeJobs = new Set();
      const updateVideoProgress = () => {
        const total = Math.max(1, pendingVideos.length);
        const progress = localProgress.reduce((sum, item) => sum + item * .65, 0)
          + organizeProgress.reduce((sum, item) => sum + item * .35, 0);
        const transcribed = localProgress.filter(item => item === 100).length;
        const organized = organizeProgress.filter(item => item === 100).length;
        job.percent = 45 + Math.floor(progress / total * .47);
        job.message = `正在流水处理远端视频：转写 ${transcribed}/${pendingVideos.length}，整理 ${organized}/${pendingVideos.length}`;
      };
      for (let index = 0; index < pendingVideos.length; index++) {
        const record = pendingVideos[index];
        const rawText = await this.engine.transcribeRaw(record.videoPath, {
          signal: job.controller.signal,
          onChild: child => job.child = child,
          onProgress: (stage, percent, message, modelPercent) => {
            job.stage = `video_${stage}`;
            localProgress[index] = Math.min(100, percent / .8);
            updateVideoProgress();
            if (modelPercent === undefined) return;
            job.modelState = modelPercent === 100 ? "done" : "running";
            job.modelPercent = modelPercent;
            job.modelMessage = modelPercent === 100 ? "模型下载完成" : "正在下载转文字模型";
          },
        });
        localProgress[index] = 100;
        updateVideoProgress();
        const organize = (async () => {
          if (pipelineError) return;
          record.reply = await retryNetwork("deepseek-organize", job.controller.signal, async () => {
            organizeProgress[index] = 0;
            updateVideoProgress();
            return this.engine.organizeTranscript(rawText, {
              signal: job.controller.signal,
              onProgress: percent => {
                organizeProgress[index] = percent;
                updateVideoProgress();
              },
            });
          }, this.retryDelays);
        })().catch(error => pipelineError ??= error);
        organizeJobs.add(organize);
        organize.finally(() => organizeJobs.delete(organize));
        if (organizeJobs.size >= 8) await Promise.race(organizeJobs);
        if (pipelineError) throw pipelineError;
      }
      await Promise.all(organizeJobs);
      if (pipelineError) throw pipelineError;
      Object.assign(job, { stage: "packaging", percent: 94, message: "正在封装 .soul" });
      const completed = records.filter(record => record.reply).sort((left, right) => right.createdAt - left.createdAt);
      if (!completed.length) throw new Error("远端信箱中没有已完成的往来可导出");
      const exchanges = completed.map(record => {
        const hash = contentMd5(record.incoming, record.reply);
        return {
          date: remoteDate(record.createdAt),
          time: remoteTime(record.createdAt),
          incoming: record.incoming,
          reply: record.reply,
          replyLabel: record.videoPath ? "视频回复" : "回信",
          letterId: record.letterId,
          contentMd5: hash,
          summary: "",
        };
      });
      const oldestFirst = [...exchanges].reverse();
      const oldHashes = oldestFirst.slice(0, Math.max(0, oldestFirst.length - 10)).map(exchange => exchange.contentMd5);
      const memory = {
        schema: "olivia-soul.memory",
        version: 2,
        exportedAt: new Date().toISOString(),
        person: String(value(profile, "nickname") ?? value(profile, "username") ?? uid),
        order: "newest-first",
        oldMemory: { contentMd5s: oldHashes, summary: "" },
        exchanges,
      };
      const byId = new Map(exchanges.map(exchange => [exchange.letterId, exchange]));
      const videoFiles = completed.filter(record => record.videoPath).map(record => ({
        letterId: record.letterId,
        contentMd5: byId.get(record.letterId).contentMd5,
        filePath: record.videoPath,
      }));
      await writeSoulBundle(job.outputPath, memory, videoFiles);
      job.letters = exchanges.length;
      Object.assign(job, { state: "done", stage: "done", percent: 100, message: "远端记忆已准备完成" });
    } finally {
      job.child = null;
    }
  }

  async start() {
    if (this.active) throw new Error("远端记忆导出正在进行");
    const id = randomUUID();
    const job = {
      id,
      kind: "remote-memory",
      state: "running",
      stage: "queued",
      percent: 0,
      message: "等待处理",
      letters: 0,
      videos: 0,
      skipped: 0,
      error: null,
      modelState: "idle",
      modelPercent: 0,
      modelMessage: "",
      controller: new AbortController(),
      child: null,
      workDir: join(this.tempDir, id),
      outputPath: join(this.tempDir, `${id}.soul`),
    };
    this.jobs.set(id, job);
    this.active = job;
    console.log(`[remote-job] started id=${id}`);
    job.promise = this.execute(job).catch(error => {
      const failedStage = job.stage;
      job.state = error.code === "CANCELLED" ? "cancelled" : "failed";
      job.stage = job.state;
      const reason = error.message === "terminated" ? "连接在传输过程中意外中断" : error.message;
      job.error = job.state === "cancelled" ? reason : `${remoteStageName(failedStage)}失败：${reason}`;
      job.message = job.error;
      console.error(`[remote-job] ${job.state} id=${id} stage=${failedStage} error=${error.message} cause=${error.cause?.code ?? ""}`);
      if (job.modelState === "running") {
        job.modelState = "failed";
        job.modelMessage = job.error;
      }
    }).finally(async () => {
      if (this.active === job) this.active = null;
      if (job.state !== "done") {
        await rm(job.workDir, { recursive: true, force: true });
        await rm(job.outputPath, { force: true });
      }
      console.log(`[remote-job] finalized id=${id} state=${job.state} letters=${job.letters} videos=${job.videos}`);
    });
    return snapshot(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("远端导出任务不存在");
    return snapshot(job);
  }

  file(id) {
    const job = this.jobs.get(id);
    if (!job || job.state !== "done") throw new Error("远端记忆尚未准备完成");
    return job.outputPath;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("远端导出任务不存在");
    if (job.state !== "running") return snapshot(job);
    job.controller.abort();
    job.child?.kill();
    return snapshot(job);
  }

  async cleanup(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    await rm(job.workDir, { recursive: true, force: true });
    await rm(job.outputPath, { force: true });
    this.jobs.delete(id);
  }

  async close() {
    for (const job of this.jobs.values())
      if (job.state === "running") job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job => job.promise).filter(Boolean));
    for (const id of [...this.jobs.keys()]) await this.cleanup(id);
  }
}
