import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 1024 ** 3;
const activeStates = new Set(['connecting', 'downloading', 'verifying']);
function identity(release) {
  const { latestTag: tag, asset = {} } = release ?? {};
  if (!/^[\w.-]+$/.test(tag ?? '') || tag === '.' || tag === '..'
    || !/^OliviaSoul-[\w.-]+-Setup\.exe$/i.test(asset.name ?? '')
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES
    || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''))
    throw new Error('安装包版本、大小或 SHA-256 信息无效');
  return { tag, id: String(asset.id ?? ''), name: asset.name, url: String(asset.url),
    size: asset.size, digest: asset.digest };
}
const keyOf = info => createHash('sha256').update(JSON.stringify(info)).digest('hex');
async function sizeOf(path) {
  try { return (await stat(path)).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
}
async function hashOf(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
// Every writable descendant is private to updates; reject reparse/symlink escapes.
async function safePath(root, path) {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('更新保存路径无效');
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('更新目录不能使用链接路径'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

export async function createUpdateDownloader({ root, fetchRelease, request = fetch, canInstall = () => true, idleTimeoutMs = 120_000,
  now = () => performance.now() }) {
  root = resolve(root);
  const stateFile = join(root, 'download-state.json');
  let state = { state: 'idle', jobId: null, bytes: 0, totalBytes: 0, percent: 0,
    bytesPerSecond: 0, remainingSeconds: null, error: null };
  let pending = null, aborter = null, closed = false, saved = null, cancelling = null, cancellable = null, pausing = null;
  let createdTarget = false;
  let samples = [], transferStarted = 0;
  function speedSnapshot() {
    const time = now(); samples = samples.filter(sample => time - sample.time < 5000);
    if (time - transferStarted < 1000) return { bytesPerSecond: 0, remainingSeconds: null };
    const bytesPerSecond = Math.round(samples.reduce((sum, sample) => sum + sample.bytes, 0)
      / Math.max(0.001, Math.min(5000, time - transferStarted) / 1000));
    return { bytesPerSecond, remainingSeconds: bytesPerSecond ? Math.ceil((state.totalBytes - state.bytes) / bytesPerSecond) : null };
  }
  const atomicJson = async (path, value) => {
    await safePath(root, path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await rename(temporary, path);
  };
  const paths = info => {
    const dir = join(root, info.tag, keyOf(info));
    return { dir, target: join(dir, info.name), part: join(dir, `${info.name}.part`), metadata: join(dir, 'partial.json') };
  };
  const persist = async () => {
    await safePath(root, stateFile); await mkdir(root, { recursive: true });
    await atomicJson(stateFile, { info: saved, state: state.state });
  };
  await safePath(root, stateFile);
  try {
    const record = JSON.parse(await readFile(stateFile, 'utf8'));
    if (record.state === 'paused') state.state = 'paused';
    if (record.info) {
    const info = identity({ latestTag: record.info.tag, asset: { ...record.info, size: record.info.size } });
    const p = paths(info); await safePath(root, p.part); await safePath(root, p.target);
    const bytes = Math.min(info.size, (await sizeOf(p.target)) || (await sizeOf(p.part)));
    // Never trust persisted "completed" to authorize installation without rehashing.
    state = { ...state, state: record.state === 'paused' ? 'paused' : 'idle', tag: info.tag, bytes, totalBytes: info.size, percent: 100 * bytes / info.size };
    saved = info;
    cancellable = record.state === 'completed' ? null : info;
    }
  } catch (e) { if (e.code !== 'ENOENT') state.error = '未能恢复上次下载状态，可重新下载'; }

  async function run(signal) {
    signal.throwIfAborted();
    const release = await fetchRelease(signal);
    signal.throwIfAborted();
    const info = identity(release), p = paths(info);
    saved = info; cancellable = info;
    state = { ...state, tag: info.tag, bytes: 0, totalBytes: info.size, percent: 0 };
    for (const path of Object.values(p)) await safePath(root, path);
    await mkdir(p.dir, { recursive: true });
    await persist();
    if (await sizeOf(p.target)) {
      state.state = 'verifying'; state.bytes = info.size; state.percent = 100;
      if (await sizeOf(p.target) === info.size && await hashOf(p.target, signal) === info.digest) {
        state = { ...state, state: 'completed', path: p.target, sha256: info.digest.slice(7), remainingSeconds: 0 }; return;
      }
      await rename(p.target, `${p.target}.invalid-${randomUUID()}`);
    }
    let metadata;
    try { metadata = JSON.parse(await readFile(p.metadata, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    let offset = await sizeOf(p.part);
    if (offset && (metadata?.identity !== keyOf(info) || offset > info.size)) {
      await rename(p.part, `${p.part}.invalid-${randomUUID()}`); offset = 0;
    }
    state.bytes = offset; state.percent = offset * 100 / info.size;
    if (offset < info.size) {
      const transfer = new AbortController();
      const transferSignal = AbortSignal.any([signal, transfer.signal]);
      let timer;
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => transfer.abort(new Error('连续两分钟未收到数据，已保留进度，可重试下载')), idleTimeoutMs); };
      touch();
      try {
        const headers = { 'User-Agent': 'OliviaSoul-Updater' };
        if (offset) {
          headers.Range = `bytes=${offset}-`;
          if (metadata.etag) headers['If-Range'] = metadata.etag;
        }
        const response = await request(info.url, { headers, signal: transferSignal });
        let accepted = false;
        try {
          if (!response.ok || !response.body) throw new Error(`下载 HTTP ${response.status}`);
          const etag = response.headers.get('etag');
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
            if (!range || Number(range[1]) !== offset || Number(range[2]) !== info.size - 1
              || Number(range[3]) !== info.size || (offset && metadata?.etag && etag && metadata.etag !== etag))
              throw new Error('服务器返回的续传位置或文件标识不一致，已保留原进度');
          } else if (response.status === 200) offset = 0;
          else throw new Error(`不支持的下载响应 HTTP ${response.status}`);
          const contentLength = response.headers.get('content-length');
          if (contentLength !== null && Number(contentLength) !== info.size - offset)
            throw new Error('服务器返回的安装包长度不一致');
          await atomicJson(p.metadata, { identity: keyOf(info), etag: etag && !etag.startsWith('W/') ? etag : null });
          state.state = 'downloading'; state.bytes = offset; state.percent = offset * 100 / info.size;
          transferStarted = now(); samples = []; let received = 0;
          const output = await open(p.part, offset ? 'a' : 'w');
          try {
            const writer = new Writable({ write(chunk, _encoding, callback) {
              touch();
              if (offset + received + chunk.length > info.size) return callback(new Error('安装包超过声明大小'));
              output.writeFile(chunk).then(() => {
                received += chunk.length; state.bytes = offset + received;
                state.percent = state.bytes * 100 / info.size;
                const time = now(), last = samples.at(-1);
                if (last && time - last.time < 250) last.bytes += chunk.length;
                else samples.push({ time, bytes: chunk.length });
                Object.assign(state, speedSnapshot());
                callback();
              }, callback);
            } });
            accepted = true;
            await pipeline(Readable.fromWeb(response.body), writer, { signal: transferSignal });
          } finally { await output.close(); }
        } finally { if (!accepted) await response.body?.cancel().catch(() => {}); }
      } catch (error) { if (transfer.signal.aborted) throw transfer.signal.reason; throw error; }
      finally { clearTimeout(timer); }
    }
    state.state = 'verifying'; state.bytesPerSecond = 0; state.remainingSeconds = null;
    if (await sizeOf(p.part) !== info.size) throw new Error('安装包尚未下载完整，已保留进度');
    if (await hashOf(p.part, signal) !== info.digest) {
      await rename(p.part, `${p.part}.invalid-${randomUUID()}`);
      state.bytes = 0; state.percent = 0;
      throw new Error('安装包 SHA-256 校验失败，重试将重新下载');
    }
    signal.throwIfAborted();
    await rename(p.part, p.target);
    createdTarget = true;
    state = { ...state, state: 'completed', bytes: info.size, percent: 100, path: p.target,
      sha256: info.digest.slice(7), remainingSeconds: 0 };
  }
  return {
    async prepareInstall(path) {
      const ready = state, info = saved;
      const allowed = () => !closed && !pending && !cancelling && !pausing && state === ready
        && ready.state === 'completed' && info && canInstall(info.tag);
      if (!allowed()) throw new Error('安装包未就绪或版本不高于当前版本，请重新检查更新');
      const target = paths(info).target;
      if (resolve(String(path ?? '')) !== target) throw new Error('安装路径与当前校验通过的任务不匹配');
      await safePath(root, target);
      if (await sizeOf(target) !== info.size || await hashOf(target) !== info.digest || !allowed())
        throw new Error('安装包校验失败或任务已变化，请重新检查更新');
      return { path: target };
    },
    status() { return { ...state, ...(cancelling ? { state: 'cancelling' } : pausing ? { state: 'pausing' } : {}), ...(state.state === 'downloading' ? speedSnapshot() : {}), running: Boolean(pending || cancelling || pausing) }; },
    start() {
      if (closed) throw new Error('更新服务正在关闭');
      if (pending || cancelling || pausing || activeStates.has(state.state)) return this.status();
      createdTarget = false;
      cancellable = state.state === 'completed' ? null : saved;
      state = { state: 'connecting', jobId: randomUUID(), bytes: state.bytes, totalBytes: state.totalBytes,
        percent: state.percent, bytesPerSecond: 0, remainingSeconds: null, error: null };
      aborter = new AbortController();
      pending = Promise.resolve().then(() => run(aborter.signal)).catch(async error => {
        state.state = 'failed'; state.bytesPerSecond = 0; state.remainingSeconds = null;
        state.error = closed ? '程序已退出，下载进度已保留' : String(error.message || error);
        delete state.path;
        if (saved) { const p = paths(saved); state.bytes = await sizeOf(p.part).catch(() => 0); state.percent = state.totalBytes ? state.bytes * 100 / state.totalBytes : 0; }
      }).finally(async () => {
        try { if (saved) await persist(); } catch { state.error = `${state.error || ''} 下载状态保存失败`; }
        pending = null;
      });
      return this.status();
    },
    pause(jobId) {
      if (jobId !== state.jobId) return Promise.reject(new Error('下载任务已变化，请刷新后重试'));
      if (cancelling) return cancelling;
      if (pausing) return pausing;
      if (!pending) return Promise.resolve(this.status());
      aborter?.abort(new Error('用户暂停下载'));
      pausing = (async () => {
        await pending;
        try {
          if (state.state !== 'completed') {
            state.state = 'paused'; state.bytesPerSecond = 0; state.remainingSeconds = null; state.error = null;
            delete state.path;
            await persist();
          }
        } catch (error) {
          state.state = 'failed'; state.error = `下载已停止，但暂停状态保存失败：${error.message}`;
          throw new Error(state.error);
        } finally { pausing = null; }
        return this.status();
      })();
      return pausing;
    },
    cancel(jobId) {
      if (jobId !== state.jobId) return Promise.reject(new Error('下载任务已变化，请刷新后重试'));
      if (cancelling) return cancelling;
      if (state.state === 'cancelled') return Promise.resolve(this.status());
      // Completed packages cannot be deleted by a stale Cancel click. A cancel
      // accepted during transfer still owns cleanup if rename wins the race.
      if (!pending && state.state === 'completed') return Promise.reject(new Error('下载任务已完成，不能取消'));
      aborter?.abort(new Error('用户取消下载'));
      cancelling = (async () => {
        if (pausing) await pausing.catch(() => {});
        await pending;
        try {
          if (cancellable) {
            const p = paths(cancellable);
            const files = [p.part, p.metadata, ...(createdTarget ? [p.target] : [])];
            for (const file of files) await safePath(root, file);
            for (const file of files) await rm(file, { force: true });
          }
          saved = null; cancellable = null;
          state = { state: 'cancelled', jobId, bytes: 0, totalBytes: 0, percent: 0,
            bytesPerSecond: 0, remainingSeconds: null, error: null };
          await persist();
        } catch (error) {
          state.state = 'failed'; state.error = `下载已停止，但清理失败：${error.message}`;
          delete state.path;
          throw new Error(state.error);
        } finally { cancelling = null; }
        return this.status();
      })();
      return cancelling;
    },
    async close() { closed = true; aborter?.abort(); await pending; await pausing; await cancelling; },
  };
}
