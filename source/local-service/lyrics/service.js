import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { songVariants } from '../midi/song-metadata.js';
import { MAX_LRC_BYTES, parseLrc, lyricPair } from './lrc.js';

const appearanceDefaults = { fontSize: 28, fontFamily: 'auto', fontWeight: 'normal', opacity: 100,
  currentColor: '#ffebaa', nextColor: '#ffffff', lineMode: 'double', orientation: 'horizontal', animate: true };
const defaults = { enabled: false, locked: false, x: null, y: null, horizontalX: null, horizontalY: null, verticalX: null, verticalY: null, ...appearanceDefaults };
const error = message => Object.assign(new Error(message), { status: 400 });
const hash = value => createHash('sha256').update(value).digest('hex');
async function createCore({ db, root, getSong, onFrame = () => {}, now = () => performance.now(), staleMs = 3500 }) {
  const directory = join(root, 'lyrics');
  await mkdir(directory, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS lyrics_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lyrics_bindings (song_id TEXT NOT NULL, variant TEXT NOT NULL, identity TEXT NOT NULL,
      content_hash TEXT NOT NULL, lines TEXT NOT NULL, filename TEXT NOT NULL, offset_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(song_id,variant));`);
  db.exec('CREATE TABLE IF NOT EXISTS lyrics_unbound (song_id TEXT NOT NULL, variant TEXT NOT NULL, PRIMARY KEY(song_id,variant))');
  function shareUnbound(songId, source) {
    const song = getSong(songId); if (!song || !source) return;
    const insert = db.prepare('INSERT OR IGNORE INTO lyrics_bindings VALUES(?,?,?,?,?,?,0)');
    for (const variant of songVariants(song)) {
      if (db.prepare('SELECT 1 FROM lyrics_unbound WHERE song_id=? AND variant=?').get(songId, variant.key)) continue;
      insert.run(songId, variant.key, hash(variant.path), source.content_hash, source.lines, source.filename);
    }
  }
  // Upgrade legacy one-variant imports without replacing any existing binding/offset.
  for (const { song_id } of db.prepare('SELECT DISTINCT song_id FROM lyrics_bindings').all()) {
    const song = getSong(song_id); if (!song) continue;
    const variants = songVariants(song);
    const source = db.prepare('SELECT * FROM lyrics_bindings WHERE song_id=? ORDER BY variant').all(song_id)
      .find(row => variants.some(v => v.key === row.variant && hash(v.path) === row.identity));
    shareUnbound(song_id, source);
  }
  let settings = { ...defaults };
  try { Object.assign(settings, JSON.parse(db.prepare('SELECT value FROM lyrics_settings WHERE id=1').get()?.value || '{}')); }
  catch { /* Missing/broken lyrics preferences must not stop the service. */ }
  settings.enabled = settings.enabled === true; settings.locked = settings.locked === true;
  settings.fontSize = Math.max(16, Math.min(64, Number(settings.fontSize) || 28));
  for (const key of ['x', 'y', 'horizontalX', 'horizontalY', 'verticalX', 'verticalY']) if (!Number.isInteger(settings[key]) || Math.abs(settings[key]) > 100000) settings[key] = null;
  for (const key of ['currentColor', 'nextColor']) if (!/^#[0-9a-f]{6}$/iu.test(settings[key])) settings[key] = defaults[key];
  if (!['single', 'double'].includes(settings.lineMode)) settings.lineMode = 'double';
  if (!['horizontal', 'vertical'].includes(settings.orientation)) settings.orientation = 'horizontal';
  if (typeof settings.fontFamily !== 'string' || !settings.fontFamily.trim() || settings.fontFamily.length > 100 || /[\x00-\x1f]/u.test(settings.fontFamily)) settings.fontFamily = 'auto';
  settings.animate = settings.animate !== false;
  if (!['normal', 'bold'].includes(settings.fontWeight)) settings.fontWeight = 'normal';
  if (!Number.isInteger(settings.opacity) || settings.opacity < 20 || settings.opacity > 100) settings.opacity = 100;
  const instance = randomUUID();
  let sequence = 0, generation = 0, controlEpoch = 0, closed = false, timer = null, cached = null;
  let sample = null, sampleAt = -Infinity, selected = null, tail = Promise.resolve();
  let status = settings.enabled ? '待命：等待有效播放进度' : '歌词已关闭';
  function emit(pair = {}) {
    if (closed) return;
    const frame = { instance, sequence: ++sequence, generation, controlEpoch, settings: { ...settings }, status,
      songId: sample?.songId || '', sessionId: sample?.sessionId || '', mediaUrl: sample?.mediaUrl || '',
      variant: selected?.key || '', offsetMs: cached?.row?.offset ?? 0, playbackState: sample?.playbackState || 'stopped',
      current: '', next: '', visible: false, ...pair };
    try { onFrame(frame); } catch { /* Presentation failures cannot reach playback. */ }
    return frame;
  }
  function clear(message) { clearTimeout(timer); timer = null; cached = null; status = message; return emit(); }
  function show(pair) {
    const frame = emit({...pair, visible: Boolean(pair.current || pair.next)});
    const epoch = generation;
    timer = setTimeout(() => { if (epoch === generation && !closed) clear('进度已过期，等待播放器上报'); }, Math.max(1, staleMs - (now() - sampleAt)));
    timer.unref?.(); return frame;
  }
  function placeholder(message) {
    status = message;
    return show({current: String(sample?.name || '').trim() || '正在播放', next:'暂无歌词，尽情欣赏音乐'});
  }
  function variantInfo(songId, key) {
    const song = getSong(songId);
    if (!song) throw error('作品不存在');
    const variant = songVariants(song).find(item => item.key === key);
    if (!variant) throw error('媒体版本不存在，请重新打开作品编辑器');
    return { key, identity: hash(variant.path) };
  }
  function refresh() {
    if (closed) return;
    clearTimeout(timer); timer = null;
    if (!settings.enabled) return clear('歌词已关闭');
    if (!sample || !['playing','paused'].includes(sample.playbackState) || !sample.sessionId || !selected
      || now() - sampleAt >= staleMs) return clear('待命：等待有效播放进度');
    try {
      if (selected.official) return placeholder('官方曲目暂无歌词');
      const { identity } = variantInfo(sample.songId, selected.key);
      const cacheKey = `${sample.songId}\n${selected.key}\n${identity}`;
      if (cached?.key !== cacheKey) {
        const row = db.prepare('SELECT * FROM lyrics_bindings WHERE song_id=? AND variant=? AND identity=?')
          .get(sample.songId, selected.key, identity);
        cached = { key: cacheKey, row: row ? { lines: JSON.parse(row.lines), offset: row.offset_ms } : null };
      }
      if (!cached.row) return placeholder('当前媒体版本尚未关联歌词，请在作品编辑器导入 LRC');
      const pair = lyricPair(cached.row.lines, sample.currentTime, cached.row.offset);
      status = (sample.playbackState === 'paused' ? '已暂停：' : '已同步：') + (sample.name || '当前作品');
      return show(pair);
    } catch { cached = null; return placeholder('歌词暂时不可用，请检查或重新导入 LRC'); }
  }
  function updateSettings(patch) {
    if (closed) throw error('歌词服务已关闭');
    if (Object.hasOwn(patch || {}, 'resetAppearance')) {
      if (patch.resetAppearance !== true || Object.keys(patch).length !== 1) throw error('恢复外观参数无效');
      patch = appearanceDefaults;
    }
    const next = { ...settings };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!Object.hasOwn(defaults, key)) throw error('未知歌词设置');
      if (key === 'enabled' || key === 'locked' || key === 'animate') { if (typeof value !== 'boolean') throw error('歌词开关值无效'); }
      else if (key === 'currentColor' || key === 'nextColor') { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) throw error('请选择有效歌词颜色'); }
      else if (key === 'lineMode') { if (!['single', 'double'].includes(value)) throw error('请选择单行或双行'); }
      else if (key === 'orientation') { if (!['horizontal', 'vertical'].includes(value)) throw error('请选择横排或竖排'); }
      else if (key === 'fontWeight') { if (!['normal', 'bold'].includes(value)) throw error('请选择常规或粗体'); }
      else if (key === 'opacity') { if (!Number.isInteger(value) || value < 20 || value > 100) throw error('不透明度须为 20–100'); }
      else if (key === 'fontFamily') { if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/u.test(value)) throw error('字体名称无效'); }
      else if (key === 'fontSize') { if (!Number.isInteger(value) || value < 16 || value > 64) throw error('字号须为 16–64'); }
      else if (value !== null && (!Number.isInteger(value) || Math.abs(value) > 100000)) throw error('窗口位置无效');
      next[key] = value;
    }
    if (next.orientation !== settings.orientation) {
      next[settings.orientation + 'X'] = settings.x; next[settings.orientation + 'Y'] = settings.y;
      next.x = next[next.orientation + 'X']; next.y = next[next.orientation + 'Y'];
    }
    db.prepare('INSERT INTO lyrics_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(next));
    if (next.enabled !== settings.enabled) controlEpoch++;
    settings = next; generation++;
    refresh(); return { settings: { ...settings }, status };
  }
  function observe(state, source, confirmed = false) {
    if (closed) return;
    // Keep only the latest small sample even when disabled; never load lyrics then.
    const changed = !sample || state.sessionId !== sample.sessionId || state.mediaUrl !== sample.mediaUrl;
    sample = { ...state }; selected = source ? { key: source.key, official: source.official === true } : null;
    if (changed) { generation++; controlEpoch++; cached = null; sampleAt = -Infinity; if (settings.enabled) clear('正在切换作品'); }
    if (confirmed) sampleAt = now();
    else if (['play', 'seek', 'stop'].includes(state.event)) sampleAt = -Infinity;
    if (settings.enabled) refresh();
  }
  function info(songId) {
    const song = getSong(songId); if (!song) throw error('作品不存在');
    return { songId, variants: songVariants(song).map(variant => {
      const row = db.prepare('SELECT filename,offset_ms,identity FROM lyrics_bindings WHERE song_id=? AND variant=?').get(songId, variant.key);
      const valid = row?.identity === hash(variant.path);
      return { key: variant.key, bound: valid, filename: valid ? row.filename : '', offsetMs: valid ? row.offset_ms : 0 };
    }) };
  }
  function save(songId, body, remove = false) {
    // Serialize import/replace/offset changes in receipt order. Playback never awaits this queue.
    const operation = tail.catch(() => {}).then(async () => {
      if (closed) throw error('歌词服务已关闭');
      const key = String(body.variant || ''), selectedVariant = variantInfo(songId, key);
      if (remove) {
        db.prepare('INSERT OR IGNORE INTO lyrics_unbound VALUES(?,?)').run(songId, key);
        db.prepare('DELETE FROM lyrics_bindings WHERE song_id=? AND variant=?').run(songId, key);
      }
      else {
        const offset = Number(body.offsetMs ?? 0);
        if (!Number.isInteger(offset) || Math.abs(offset) > 600000) throw error('时间偏移须为 -600000 至 600000 毫秒');
        if (body.contentBase64 !== undefined) {
          if (typeof body.contentBase64 !== 'string' || body.contentBase64.length > Math.ceil(MAX_LRC_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body.contentBase64)) throw error('歌词文件无效或超过 256 KiB');
          const bytes = Buffer.from(body.contentBase64, 'base64');
          let parsed; try { parsed = parseLrc(bytes); } catch (failure) { throw error(failure.message); }
          const filename = String(body.filename || '歌词.lrc').replace(/.*[\\/]/u, '').slice(0, 150);
          if (!/\.lrc$/iu.test(filename)) throw error('请选择 .lrc 文件');
          const contentHash = hash(bytes);
          await writeFile(join(directory, contentHash + '.lrc'), bytes, { flag: 'wx' }).catch(failure => { if (failure.code !== 'EEXIST') throw failure; });
          if (closed) throw error('歌词服务已关闭');
          if (variantInfo(songId, key).identity !== selectedVariant.identity) throw error('媒体已经变化，请重新导入');
          db.prepare(`INSERT INTO lyrics_bindings VALUES(?,?,?,?,?,?,?) ON CONFLICT(song_id,variant) DO UPDATE SET
            identity=excluded.identity,content_hash=excluded.content_hash,lines=excluded.lines,filename=excluded.filename,offset_ms=excluded.offset_ms`)
            .run(songId, key, selectedVariant.identity, contentHash, JSON.stringify(parsed.lines), filename, offset);
          db.prepare('DELETE FROM lyrics_unbound WHERE song_id=? AND variant=?').run(songId, key);
          shareUnbound(songId, { content_hash: contentHash, lines: JSON.stringify(parsed.lines), filename });
        } else {
          const result = db.prepare('UPDATE lyrics_bindings SET offset_ms=? WHERE song_id=? AND variant=? AND identity=?').run(offset, songId, key, selectedVariant.identity);
          if (!result.changes) throw error('请先为此媒体版本导入歌词');
        }
      }
      cached = null; generation++; if (settings.enabled) refresh();
      return info(songId);
    });
    tail = operation; return operation;
  }
  function adjustOffset(request) {
    const operation = tail.catch(() => {}).then(() => {
      if (closed || !settings.enabled || !sample || !['playing','paused'].includes(sample.playbackState) || now() - sampleAt >= staleMs
        || request.controlEpoch !== controlEpoch || request.songId !== sample.songId || request.sessionId !== sample.sessionId
        || request.mediaUrl !== sample.mediaUrl || request.variant !== selected?.key) throw error('播放已经变化，请重新调整当前歌词');
      if (request.reset !== true && ![-500, 500].includes(request.deltaMs)) throw error('快捷偏移须为提前或延后 500 毫秒');
      const { identity } = variantInfo(sample.songId, selected.key);
      const row = db.prepare('SELECT offset_ms FROM lyrics_bindings WHERE song_id=? AND variant=? AND identity=?').get(sample.songId, selected.key, identity);
      if (!row) throw error('当前版本没有关联歌词');
      const offset = request.reset === true ? 0 : Math.max(-600000, Math.min(600000, row.offset_ms + request.deltaMs));
      db.prepare('UPDATE lyrics_bindings SET offset_ms=? WHERE song_id=? AND variant=? AND identity=?').run(offset, sample.songId, selected.key, identity);
      cached = null; generation++; refresh(); return { offsetMs: offset };
    });
    tail = operation; return operation;
  }
  return {
    observe, updateSettings, info, save, adjustOffset,
    snapshot() { return refresh() || emit(); },
    settings() { return { settings: { ...settings }, status }; },
    async close() { if (closed) return; clear('歌词服务已停止'); closed = true; generation++; cached = null; sample = null; await tail.catch(() => {}); },
  };
}

export async function createLyricsService(options) {
  try { return await createCore(options); }
  catch {
    const status = '歌词存储暂时不可用，请检查 UserData 写入权限';
    const unavailable = () => { throw error(status); };
    const instance = randomUUID(); let sequence = 0;
    return { observe() {}, async close() {}, info: unavailable, save: unavailable, updateSettings: unavailable, adjustOffset: unavailable,
      settings: () => ({ settings: { ...defaults }, status }),
      snapshot() { const frame = { instance, sequence: ++sequence, generation: 0, settings: { ...defaults }, status, visible: false, current: '', next: '' }; try { options.onFrame?.(frame); } catch {} return frame; } };
  }
}
