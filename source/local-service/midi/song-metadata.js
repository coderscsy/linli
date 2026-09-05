export const TIME_SLOTS = ["TOD12", "TOD1730", "TOD20"];

export function songVariants(song) {
  const entries = Object.entries(song.videoByTodView ?? {}).filter(([, path]) => typeof path === "string" && path);
  if (song.videoPath && !entries.some(([, path]) => path === song.videoPath)) entries.unshift(["default", song.videoPath]);
  return entries.map(([key, path]) => {
    const match = /(?:^|[^A-Z0-9])TOD(1200|1730|2000|12|17|20)(?=$|[^0-9])/u.exec(key.toUpperCase());
    const tod = match ? ({ 1200: "TOD12", 12: "TOD12", 1730: "TOD1730", 17: "TOD1730", 2000: "TOD20", 20: "TOD20" })[match[1]] : null;
    const view = /(?:^|[_-])(NI|WI)(?:$|[_-])/u.exec(key.toUpperCase())?.[1] ?? null;
    return { key, path, tod, view };
  });
}

export function describeSongMetadata(song, req) {
  const variants = songVariants(song);
  const mapping = { TOD12: null, TOD1730: null, TOD20: null };
  const manual = song.timeOfDayMapping != null;
  const single = new Set(variants.map(item => item.path)).size === 1;
  for (const tod of TIME_SLOTS) {
    const selected = manual
      ? variants.find(item => item.key === song.timeOfDayMapping[tod])
      : single ? variants[0] : variants.find(item => item.tod === tod);
    mapping[tod] = selected?.key ?? null;
  }
  const base = req ? `http://${req.headers?.host || "127.0.0.1:27149"}` : "";
  return {
    id: song.id,
    name: song.customName ?? song.correctedName ?? song.name,
    originalName: song.originalName ?? song.name,
    customName: song.customName ?? null,
    correctedName: song.correctedName ?? null,
    nameSync: song.nameSync ?? { state: "synced", error: null },
    variants: variants.map(({ key, path, tod, view }) => ({ key, filename: path.replaceAll("\\", "/").split("/").at(-1), url: `${base}/toy/midi/songs/${encodeURIComponent(song.id)}/video.mp4?variant=${encodeURIComponent(key)}`, tod, view })),
    mapping,
    mappingStatus: manual ? "manual" : single ? "single" : Object.values(mapping).some(Boolean) ? "explicit" : "unconfirmed",
  };
}

export function selectSongVariant(song, tod, view) {
  const variants = songVariants(song);
  const description = describeSongMetadata(song);
  let selected;
  if (description.mappingStatus === "explicit") selected = variants.find(item => item.tod === tod && item.view === view) ?? variants.find(item => item.tod === tod && !item.view) ?? variants.find(item => item.tod === tod);
  else selected = variants.find(item => item.key === description.mapping[tod]);
  const reason = selected ? description.mappingStatus : "unconfirmed";
  selected ??= variants.find(item => item.path === song.videoPath) ?? variants.find(item => item.key === "DEFAULT") ?? variants[0];
  return { key: selected?.key ?? null, path: selected?.path ?? null, tod, view, reason };
}
