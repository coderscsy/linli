import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runProcess as defaultRunProcess } from "./process-runner.js";
import { parseMidiTimeline } from "./timeline.js";

function safeError(error) {
  return String(error?.message ?? error ?? "未知渲染错误")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 2_000);
}

function validateProbe(stdout, expectedDurationUs) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("ffprobe 返回了无效 JSON"), { code: "RENDER_PROBE_INVALID" });
  }
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  if (!streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264")) {
    throw Object.assign(new Error("渲染结果缺少 H.264 视频流"), { code: "RENDER_VIDEO_INVALID" });
  }
  if (!streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac")) {
    throw Object.assign(new Error("渲染结果缺少 AAC 音频流"), { code: "RENDER_AUDIO_INVALID" });
  }
  const actualSeconds = Number(payload.format?.duration);
  const expectedSeconds = expectedDurationUs / 1_000_000;
  const tolerance = Math.max(1, expectedSeconds * 0.05);
  if (!Number.isFinite(actualSeconds) || Math.abs(actualSeconds - expectedSeconds) > tolerance) {
    throw Object.assign(new Error("渲染结果时长与 MIDI 时间线不一致"), { code: "RENDER_DURATION_INVALID" });
  }
}

export class MidiRenderPipeline {
  constructor({
    store,
    runProcess = defaultRunProcess,
    parser = parseMidiTimeline,
    commands = {},
    soundFont,
    godotProject,
    width = 1920,
    height = 1080,
    fps = 60,
  }) {
    if (!store) throw new TypeError("MidiRenderPipeline requires a MIDI store");
    this.store = store;
    this.runProcess = runProcess;
    this.parser = parser;
    this.commands = {
      fluidsynth: commands.fluidsynth ?? join(store.root, "runtime", "fluidsynth", "bin", "fluidsynth.exe"),
      godot: commands.godot ?? join(store.root, "runtime", "godot", "godot.exe"),
      ffmpeg: commands.ffmpeg ?? join(store.root, "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
      ffprobe: commands.ffprobe ?? join(store.root, "runtime", "ffmpeg", "bin", "ffprobe.exe"),
    };
    this.soundFont = soundFont ?? join(store.root, "soundfonts", "MuseScore_General.sf3");
    this.godotProject = godotProject ?? join(store.root, "renderer", "godot");
    this.width = width;
    this.height = height;
    this.fps = fps;
  }

  async #runStage(command, args, { signal, cwd, logPath }) {
    await appendFile(logPath, `\n> ${command} ${args.map(value => JSON.stringify(value)).join(" ")}\n`, "utf8");
    return this.runProcess(command, args, {
      signal,
      cwd,
      timeoutMs: 6 * 60 * 60 * 1_000,
      onOutput: ({ stream, chunk }) => {
        void appendFile(logPath, `[${stream}] ${chunk}`, "utf8");
      },
    });
  }

  async render(jobId, options = {}) {
    let job = this.store.getJob(jobId);
    if (!job) throw Object.assign(new Error("MIDI 生成任务不存在"), { code: "MIDI_JOB_NOT_FOUND" });
    if (job.state !== "queued") {
      throw Object.assign(new Error(`任务状态 ${job.state} 不能开始渲染`), { code: "MIDI_JOB_NOT_QUEUED" });
    }

    const jobDir = join(this.store.root, "jobs", jobId);
    const outputDir = join(this.store.root, "outputs");
    const timelinePath = join(jobDir, "timeline.json");
    const audioPath = join(jobDir, "piano.wav");
    const rawVideoPath = join(jobDir, "raw.avi");
    const partialVideoPath = join(outputDir, `${jobId}.partial.mp4`);
    const finalVideoPath = join(outputDir, `${jobId}.mp4`);
    const logPath = join(jobDir, "render.log");
    let completed = false;

    await mkdir(jobDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(logPath, `MIDI render job ${jobId}\n`, "utf8");

    try {
      job = this.store.transitionJob(jobId, "analyzing", { progress: 2 });
      const inputPath = this.store.resolvePath(job.inputPath);
      const input = await readFile(inputPath);
      const parsed = this.parser(input);
      const timeline = { title: job.title, ...parsed };
      await writeFile(timelinePath, `${JSON.stringify(timeline)}\n`, "utf8");

      job = this.store.transitionJob(jobId, "synthesizing", {
        progress: 15,
        timelinePath,
        durationUs: parsed.durationUs,
      });
      await this.#runStage(this.commands.fluidsynth, [
        "-ni",
        "-F", audioPath,
        "-r", "48000",
        this.soundFont,
        inputPath,
      ], { signal: options.signal, cwd: jobDir, logPath });

      job = this.store.transitionJob(jobId, "rendering", { progress: 45, audioPath });
      await this.#runStage(this.commands.godot, [
        "--windowed",
        "--position", "-32000,-32000",
        "--rendering-method", "gl_compatibility",
        "--path", this.godotProject,
        "--resolution", `${this.width}x${this.height}`,
        "--write-movie", rawVideoPath,
        "--fixed-fps", String(this.fps),
        "--",
        "--timeline", timelinePath,
        "--width", String(this.width),
        "--height", String(this.height),
        "--fps", String(this.fps),
        "--title", job.title,
      ], { signal: options.signal, cwd: this.godotProject, logPath });

      job = this.store.transitionJob(jobId, "muxing", { progress: 70 });
      await this.#runStage(this.commands.ffmpeg, [
        "-y",
        "-i", rawVideoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        partialVideoPath,
      ], { signal: options.signal, cwd: jobDir, logPath });
      const probe = await this.#runStage(this.commands.ffprobe, [
        "-v", "error",
        "-show_entries", "stream=codec_type,codec_name:format=duration",
        "-of", "json",
        partialVideoPath,
      ], { signal: options.signal, cwd: jobDir, logPath });
      validateProbe(probe.stdout, parsed.durationUs);
      await rename(partialVideoPath, finalVideoPath);

      const upload = this.store.getUploadByKey(job.uploadKey);
      this.store.upsertUserSong({
        jobId,
        name: job.title,
        sourceKind: "upload",
        midiPath: inputPath,
        videoPath: finalVideoPath,
        durationUs: parsed.durationUs,
        contentHash: upload?.sha256 ?? null,
        videoByTodView: { TOD1730_NI_L: this.store.encodePath(finalVideoPath) },
      });
      job = this.store.transitionJob(jobId, "completed", {
        progress: 100,
        videoPath: finalVideoPath,
        audioPath: "",
        durationUs: parsed.durationUs,
      });
      completed = true;
      return job;
    } catch (error) {
      const current = this.store.getJob(jobId);
      if (current && !["completed", "failed", "cancelled"].includes(current.state)) {
        const state = options.signal?.aborted || error?.code === "PROCESS_ABORTED" ? "cancelled" : "failed";
        this.store.transitionJob(jobId, state, { error: safeError(error) });
      }
      throw error;
    } finally {
      await Promise.all([
        rm(rawVideoPath, { force: true }),
        rm(audioPath, { force: true }),
        rm(partialVideoPath, { force: true }),
        completed ? Promise.resolve() : rm(finalVideoPath, { force: true }),
      ]);
    }
  }
}
