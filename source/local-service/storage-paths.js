import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const MINIMUM_MIGRATION_RESERVE_BYTES = 512 * 1024 ** 2;

function delay(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function decodedCandidates(buffer) {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return [value.toString("utf8"), value.toString("utf16le")]
    .map(text => text.replaceAll("\u0000", ""));
}

export function parseSongStoragePath(buffer) {
  for (const text of decodedCandidates(buffer)) {
    const match = /songStoragePath[\x00-\x20:=]{0,32}("(?:\\.|[^"\\])*")/u.exec(text);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed === "string" && parsed.trim() && isAbsolute(parsed.trim())) return parsed.trim();
    } catch {
      // Continue with the next decoding candidate.
    }
  }
  throw new Error("usersettings.dat 中没有有效的 songStoragePath");
}

export function storageDirectories(songStoragePath) {
  const root = resolve(songStoragePath, "OliviaSoul");
  return {
    root,
    performances: join(root, "我的上传"),
    videoReplies: join(root, "视频回信"),
    staging: join(root, ".staging"),
  };
}

export function checkMigrationCapacity({ requiredBytes, freeBytes }) {
  const required = Math.max(0, Number(requiredBytes) || 0);
  const free = Math.max(0, Number(freeBytes) || 0);
  const reserveBytes = Math.max(MINIMUM_MIGRATION_RESERVE_BYTES, Math.ceil(required * 0.05));
  const totalRequiredBytes = required + reserveBytes;
  return {
    requiredBytes: required,
    freeBytes: free,
    reserveBytes,
    totalRequiredBytes,
    sufficient: free >= totalRequiredBytes,
    shortfallBytes: Math.max(0, totalRequiredBytes - free),
  };
}

export async function resolveSongStoragePath({
  settingsPath,
  lastValidPath = "",
  retryCount = 5,
  retryDelayMs = 250,
  readFileImpl = readFile,
  accessImpl = access,
  sleepImpl = delay,
}) {
  let configuredPath = "";
  let lastError;
  const attempts = Math.max(1, Number(retryCount) || 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      configuredPath = parseSongStoragePath(await readFileImpl(settingsPath));
      await accessImpl(configuredPath);
      return {
        configuredPath,
        activePath: configuredPath,
        source: "game-settings",
        state: "ready",
        error: null,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(retryDelayMs);
    }
  }

  const fallback = String(lastValidPath ?? "").trim();
  if (fallback) {
    try {
      await accessImpl(fallback);
      return {
        configuredPath,
        activePath: fallback,
        source: "last-valid",
        state: "unavailable",
        error: configuredPath
          ? "游戏设置的曲目路径不可访问，继续使用上一次有效路径"
          : "暂时无法读取游戏曲目路径，继续使用上一次有效路径",
      };
    } catch {
      // Report the original settings failure below.
    }
  }

  return {
    configuredPath,
    activePath: "",
    source: "game-settings",
    state: "unavailable",
    error: lastError instanceof Error ? lastError.message : "无法读取游戏曲目路径",
  };
}
