import { runProcess as defaultRunProcess } from "./process-runner.js";

function probeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function createVideoDurationProbe({
  command,
  runProcess = defaultRunProcess,
  timeoutMs = 30_000,
}) {
  if (typeof command !== "string" || !command.trim()) throw new TypeError("FFprobe command is required");
  return async function probeVideoDurationUs(path) {
    let result;
    try {
      result = await runProcess(command, [
        "-v", "error",
        "-show_entries", "format=duration:stream=index,codec_type,codec_name",
        "-of", "json",
        path,
      ], { timeoutMs });
    } catch (error) {
      if (error?.code === "PROCESS_TIMEOUT")
        throw probeError("VIDEO_PROBE_TIMEOUT", "读取视频时长超时", error);
      if (error?.code === "PROCESS_START_FAILED")
        throw probeError("VIDEO_PROBE_UNAVAILABLE", "FFprobe 未安装或无法启动", error);
      throw probeError("VIDEO_DURATION_INVALID", "无法读取视频时长", error);
    }

    try {
      const metadata = JSON.parse(result.stdout);
      const seconds = Number(metadata.format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("duration must be positive");
      const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
      const video = streams.find(stream => stream?.codec_type === "video");
      if (!video) throw new Error("video stream is required");
      if (String(video.codec_name ?? "").toLowerCase() !== "h264")
        throw new Error("video codec must be H.264");
      const unsupportedAudio = streams.find(stream => stream?.codec_type === "audio"
        && !["aac", "mp3"].includes(String(stream.codec_name ?? "").toLowerCase()));
      if (unsupportedAudio) throw new Error("audio codec is not supported");
      return Math.round(seconds * 1_000_000);
    } catch (error) {
      throw probeError("VIDEO_DURATION_INVALID", "视频没有有效时长", error);
    }
  };
}
