// Independent LRC implementation; no upstream source is included.
export const MAX_LRC_BYTES = 256 * 1024;
export function parseLrc(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_LRC_BYTES) throw new Error('歌词文件不能为空，且不能超过 256 KiB');
  let text;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { throw new Error('歌词编码无法识别，请另存为 UTF-8 后导入'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) throw new Error('歌词含有无效控制字符');
  const rows = [], metadata = {};
  let fileOffsetMs = 0;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const meta = /^\[(ar|ti|al|by|offset):([^\]]*)\]$/iu.exec(line);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        if (!/^[+-]?\d{1,7}$/u.test(meta[2].trim())) throw new Error('LRC offset 格式错误');
        fileOffsetMs = Number(meta[2]);
      } else metadata[meta[1].toLowerCase()] = meta[2].slice(0, 200);
      continue;
    }
    const stamps = [...line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/gu)];
    if (!stamps.length) continue;
    const lyric = line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/gu, '').trim();
    if (lyric.length > 1000) throw new Error('单句歌词过长（最多 1000 字符）');
    for (const stamp of stamps) {
      rows.push({ at: (Number(stamp[1]) * 60 + Number(stamp[2])) * 1000 + Number((stamp[3] || '').padEnd(3, '0')), text: lyric });
      if (rows.length > 4000) throw new Error('歌词时间标签过多（最多 4000 条）');
    }
  }
  if (!rows.some(row => row.text)) throw new Error('未找到带有效时间戳的歌词，例如 [00:12.50]歌词');
  // LRC offset convention advances lyrics; the user-facing adjustment delays them.
  rows.forEach(row => { row.at -= fileOffsetMs; });
  rows.sort((a, b) => a.at - b.at);
  const lines = [];
  for (const row of rows) {
    const last = lines.at(-1);
    if (last?.at === row.at) {
      last.text = [...new Set([last.text, row.text].filter(Boolean))].join(' / ').slice(0, 1000);
    } else lines.push(row);
  }
  return { metadata, lines };
}

export function lyricPair(lines, currentTime, offsetMs = 0) {
  const time = currentTime * 1000 - offsetMs;
  let lo = 0, hi = lines.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid].at <= time) lo = mid + 1; else hi = mid; }
  const index = lo - 1;
  return { current: index >= 0 ? lines[index].text : '', next: lines[index + 1]?.text || '' };
}
