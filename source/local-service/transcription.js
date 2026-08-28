import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const MODEL_NAME = "ggml-small.bin";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const MODEL_MIRROR_URL = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const MODEL_SHA256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".wav", ".mp3", ".m4a", ".flac", ".ogg"]);
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;

function cancelledError() {
  const error = new Error("任务已取消");
  error.code = "CANCELLED";
  return error;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function snapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    sourceName: job.sourceName,
    rawText: job.rawText,
    organizedText: job.organizedText,
    error: job.error,
    modelState: job.modelState,
    modelPercent: job.modelPercent,
    modelMessage: job.modelMessage,
  };
}

function parseClock(value) {
  const parts = value.split(":").map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function transcriptChunks(text, maximum = 12000) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maximum) {
    const boundary = Math.max(
      remaining.lastIndexOf("\n", maximum),
      remaining.lastIndexOf("。", maximum),
      remaining.lastIndexOf("！", maximum),
      remaining.lastIndexOf("？", maximum),
    );
    const length = boundary > maximum / 2 ? boundary + 1 : maximum;
    chunks.push(remaining.slice(0, length).trim());
    remaining = remaining.slice(length).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function parseFfmpegProgress(text, duration) {
  const durationMatch = /Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/u.exec(text);
  const nextDuration = durationMatch ? parseClock(durationMatch[1]) : duration;
  const matches = [...text.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/gu)];
  const elapsed = matches.length ? parseClock(matches.at(-1)[1]) : 0;
  return {
    duration: nextDuration,
    progress: nextDuration > 0 ? Math.min(1, elapsed / nextDuration) : 0,
  };
}

export function parseWhisperProgress(text) {
  const matches = [...text.matchAll(/(?:progress\s*=\s*|\[\s*)(\d{1,3})(?:%|\s*%\s*\])/giu)];
  return matches.length ? Math.min(100, Number(matches.at(-1)[1])) : null;
}

async function runProcess(command, args, { signal, onOutput, onChild }) {
  if (signal.aborted) throw cancelledError();
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    onChild(child);
    let stderr = "";
    const consume = chunk => {
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-16000);
      onOutput(text);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      onChild(null);
      if (signal.aborted) reject(cancelledError());
      else if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `媒体处理进程异常退出：${code}`));
    });
  });
}

export class TranscriptionEngine {
  constructor({ runtimeDir, modelsDir, tempDir, readDeepSeekConfig, fetchImpl = fetch, model }) {
    this.runtimeDir = runtimeDir;
    this.modelsDir = modelsDir;
    this.tempDir = tempDir;
    this.readDeepSeekConfig = readDeepSeekConfig;
    this.fetch = fetchImpl;
    this.model = model ?? { name: MODEL_NAME, urls: [MODEL_MIRROR_URL, MODEL_URL], sha256: MODEL_SHA256 };
    this.verifiedModel = false;
    this.busy = false;
  }

  get bundledModelPath() {
    return join(this.runtimeDir, "whisper", this.model.name);
  }

  get modelPath() {
    if (existsSync(this.bundledModelPath) && /^[\x00-\x7F]+$/u.test(this.bundledModelPath))
      return this.bundledModelPath;
    return join(this.modelsDir, "whisper", this.model.name);
  }

  get ffmpegPath() {
    return join(this.runtimeDir, "ffmpeg", "bin", "ffmpeg.exe");
  }

  get whisperPath() {
    return join(this.runtimeDir, "whisper", "whisper-cli.exe");
  }

  async ensureModel(onProgress, signal) {
    await mkdir(join(this.modelsDir, "whisper"), { recursive: true });
    if (existsSync(this.modelPath)) {
      onProgress("verifying_model", 2, "正在校验语音模型");
      if (!this.verifiedModel) {
        if (await sha256(this.modelPath) !== this.model.sha256) throw new Error("本地 Whisper 模型校验失败");
        this.verifiedModel = true;
      }
      return;
    }
    const temporary = `${this.modelPath}.${randomUUID()}.tmp`;
    if (existsSync(this.bundledModelPath)) {
      onProgress("verifying_model", 1, "正在准备内置语音模型");
      if (await sha256(this.bundledModelPath) !== this.model.sha256) throw new Error("内置 Whisper 模型校验失败");
      try {
        await copyFile(this.bundledModelPath, temporary);
        await rename(temporary, this.modelPath);
        this.verifiedModel = true;
        onProgress("verifying_model", 2, "内置语音模型准备完成", 100);
        return;
      } finally {
        await rm(temporary, { force: true });
      }
    }
    onProgress("downloading_model", 0, "等待语音模型下载", 0);
    try {
      let response;
      for (const url of this.model.urls ?? [this.model.url])
        try {
          const candidate = await this.fetch(url, { signal });
          if (candidate.ok && candidate.body) {
            response = candidate;
            break;
          }
        } catch (error) {
          if (signal.aborted) throw error;
        }
      if (!response) throw new Error("Whisper 模型下载失败，请检查网络后重试");
      const total = Number(response.headers.get("content-length") ?? 0);
      let received = 0;
      const output = await open(temporary, "wx");
      try {
        for await (const chunk of response.body) {
          if (signal.aborted) throw cancelledError();
          received += chunk.length;
          await output.writeFile(chunk);
          if (total) {
            const modelPercent = Math.min(100, Math.floor(received / total * 100));
            onProgress("downloading_model", 0, "等待语音模型下载", modelPercent);
          }
        }
      } finally {
        await output.close();
      }
      if (await sha256(temporary) !== this.model.sha256) throw new Error("下载的 Whisper 模型校验失败");
      await rename(temporary, this.modelPath);
      this.verifiedModel = true;
      onProgress("downloading_model", 0, "语音模型下载完成", 100);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async organize(rawText, signal, onChunk) {
    const config = await this.readDeepSeekConfig();
    if (!config.apiKey) throw new Error("请先在基础设置中填写 DeepSeek API Key");
    const chunks = transcriptChunks(rawText);
    const organized = [];
    for (let index = 0; index < chunks.length; index++) {
      onChunk(index, chunks.length);
      const response = await this.fetch(`${config.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          messages: [
            {
              role: "system",
              content: "你是逐字稿整理员。只修正语音识别造成的错别字、同音字、标点和分段，删除无意义重复与语气噪声。不得概括、扩写、补造或改变说话人的意思。只输出整理后的正文。",
            },
            { role: "user", content: chunks[index] },
          ],
        }),
        signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`DeepSeek 整理失败：HTTP ${response.status}`);
      const content = body?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("DeepSeek 未返回整理文字");
      organized.push(content);
    }
    return organized.join("\n\n");
  }

  async transcribeRaw(sourcePath, { signal, onProgress, onChild }) {
    if (this.busy) throw new Error("已有视频正在转写");
    if (!existsSync(this.ffmpegPath)) throw new Error("缺少 FFmpeg，请重新安装 Olivia Soul");
    if (!existsSync(this.whisperPath)) throw new Error("缺少 whisper.cpp，请重新安装 Olivia Soul");
    this.busy = true;
    let workDir = "";
    try {
      await this.ensureModel(onProgress, signal);
      workDir = join(this.tempDir, "transcribe", randomUUID());
      await mkdir(workDir, { recursive: true });
      const wavPath = join(workDir, "audio.wav");
      const outputPrefix = join(workDir, "transcript");
      let duration = 0;
      let ffmpegBuffer = "";
      onProgress("extracting", 10, "正在提取音频");
      await runProcess(this.ffmpegPath, [
        "-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath,
      ], {
        signal,
        onChild,
        onOutput: text => {
          ffmpegBuffer = (ffmpegBuffer + text).slice(-8000);
          const parsed = parseFfmpegProgress(ffmpegBuffer, duration);
          duration = parsed.duration;
          onProgress("extracting", 10 + Math.floor(parsed.progress * 15), "正在提取音频");
        },
      });
      onProgress("transcribing", 25, "正在本地识别语音");
      await runProcess(this.whisperPath, [
        "-m", this.modelPath, "-f", wavPath, "-l", "zh", "-otxt", "-of", outputPrefix, "-pp",
      ], {
        signal,
        onChild,
        onOutput: text => {
          const value = parseWhisperProgress(text);
          if (value !== null) onProgress("transcribing", 25 + Math.floor(value * .55), "正在本地识别语音");
        },
      });
      const rawText = (await readFile(`${outputPrefix}.txt`, "utf8")).trim();
      if (!rawText) throw new Error("Whisper 未识别出文字");
      return rawText;
    } finally {
      this.busy = false;
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  async organizeTranscript(rawText, { signal, onProgress }) {
    onProgress(0);
    const organizedText = await this.organize(rawText, signal, (index, total) => {
      onProgress(Math.floor(index / total * 100));
    });
    onProgress(100);
    return organizedText;
  }

  async transcribe(sourcePath, { signal, onProgress, onChild }) {
    const rawText = await this.transcribeRaw(sourcePath, { signal, onProgress, onChild });
    onProgress("organizing", 82, "正在交给 DeepSeek 整理文字");
    const organizedText = await this.organizeTranscript(rawText, {
      signal,
      onProgress: percent => onProgress(
        "organizing",
        82 + Math.floor(percent * .17),
        "正在整理文字",
      ),
    });
    onProgress("done", 100, "转写完成");
    return { rawText, organizedText };
  }
}

export class TranscriptionJobs {
  constructor(engine) {
    this.engine = engine;
    this.jobs = new Map();
    this.active = null;
  }

  async start(sourcePath) {
    if (this.active) throw new Error("已有视频正在转写");
    const path = resolve(String(sourcePath ?? ""));
    if (!MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("不支持该媒体格式");
    const source = await stat(path);
    if (!source.isFile() || source.size < 1) throw new Error("媒体文件无效");
    if (source.size > MAX_MEDIA_BYTES) throw new Error("媒体文件不能超过 4 GB");
    const job = {
      id: randomUUID(),
      kind: "transcription",
      state: "running",
      stage: "queued",
      percent: 0,
      message: "等待处理",
      sourceName: path.split(/[\\/]/u).at(-1),
      rawText: "",
      organizedText: "",
      error: null,
      modelState: "idle",
      modelPercent: 0,
      modelMessage: "",
      controller: new AbortController(),
      child: null,
    };
    this.jobs.set(job.id, job);
    this.active = job;
    job.promise = this.engine.transcribe(path, {
      signal: job.controller.signal,
      onChild: child => job.child = child,
      onProgress: (stage, percent, message, modelPercent) => {
        Object.assign(job, { stage, percent, message });
        if (modelPercent === undefined) return;
        job.modelState = modelPercent === 100 ? "done" : "running";
        job.modelPercent = modelPercent;
        job.modelMessage = modelPercent === 100 ? "模型下载完成" : "正在下载转文字模型";
      },
    }).then(result => {
      Object.assign(job, result, { state: "done", stage: "done", percent: 100, message: "转写完成" });
    }).catch(error => {
      job.state = error.code === "CANCELLED" ? "cancelled" : "failed";
      job.stage = job.state;
      job.error = error.message;
      job.message = error.message;
      if (job.modelState === "running") {
        job.modelState = "failed";
        job.modelMessage = error.message;
      }
    }).finally(() => {
      if (this.active === job) this.active = null;
      job.child = null;
    });
    return snapshot(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("转写任务不存在");
    return snapshot(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("转写任务不存在");
    if (job.state !== "running") return snapshot(job);
    job.controller.abort();
    job.child?.kill();
    return snapshot(job);
  }

  async close() {
    for (const job of this.jobs.values())
      if (job.state === "running") job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job => job.promise).filter(Boolean));
  }
}
