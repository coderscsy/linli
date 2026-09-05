// Match the native desktop player's localtime64 boundaries. TOD1730 is an
// asset label; the native evening range starts at 16:00, not 17:30.
export function playbackTimeOfDay(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (!Number.isFinite(minutes)) throw new TypeError("Invalid playback clock");
  return minutes >= 360 && minutes < 960 ? "TOD12"
    : minutes >= 960 && minutes < 1200 ? "TOD1730" : "TOD20";
}
